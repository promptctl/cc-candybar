// The framed render exchange has one deadline for the header, body and retry.
// The socket stays nonblocking. Readiness means "try the operation again":
// a hangup can still have a complete response buffered in the kernel.
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::Instant;

use crate::remaining_or_io;

pub(crate) struct DeadlineStream {
    socket: UnixStream,
    deadline: Instant,
}

impl DeadlineStream {
    pub(crate) fn new(socket: UnixStream, deadline: Instant) -> io::Result<Self> {
        socket.set_nonblocking(true)?;
        Ok(Self { socket, deadline })
    }

    fn try_until<T>(
        &self,
        events: libc::c_short,
        mut operation: impl FnMut(&UnixStream) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut descriptor = libc::pollfd {
            fd: self.socket.as_raw_fd(),
            events,
            revents: 0,
        };
        loop {
            remaining_or_io(self.deadline)?;
            match operation(&self.socket) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                result => return result,
            }
            let remaining = remaining_or_io(self.deadline)?;
            let millis = remaining.as_nanos().div_ceil(1_000_000);
            let timeout = libc::c_int::try_from(millis).unwrap_or(libc::c_int::MAX);
            // SAFETY: the one initialized descriptor refers to our live socket
            // throughout poll. On timeout or interruption the loop rechecks
            // the original deadline before it attempts another read or write.
            if unsafe { libc::poll(&mut descriptor, 1, timeout) } < 0 {
                let err = io::Error::last_os_error();
                if err.kind() != io::ErrorKind::Interrupted {
                    return Err(err);
                }
            }
        }
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.try_until(libc::POLLIN, |mut socket| socket.read(buf))
    }
}

impl Write for DeadlineStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.try_until(libc::POLLOUT, |mut socket| socket.write(buf))
    }

    fn flush(&mut self) -> io::Result<()> {
        self.socket.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{classify_io_error, read_frame, write_frame, RenderOutcome};
    use std::time::Duration;

    #[test]
    fn a_closed_peer_can_have_a_complete_reply_waiting() {
        let (client, mut peer) = UnixStream::pair().unwrap();
        write_frame(&mut peer, b"buffered reply").unwrap();
        drop(peer);
        let mut client =
            DeadlineStream::new(client, Instant::now() + Duration::from_secs(10)).unwrap();
        assert_eq!(read_frame(&mut client).unwrap(), b"buffered reply");
    }

    #[test]
    fn a_stalled_partial_header_or_body_uses_the_render_deadline() {
        for partial in [&[0, 0][..], &[0, 0, 0, 3, b'a'][..]] {
            let (client, mut peer) = UnixStream::pair().unwrap();
            peer.write_all(partial).unwrap();
            let mut client =
                DeadlineStream::new(client, Instant::now() + Duration::from_millis(5)).unwrap();
            assert!(matches!(
                classify_io_error(read_frame(&mut client).unwrap_err()),
                RenderOutcome::Busy
            ));
        }
    }

    #[test]
    fn a_closed_peer_with_a_truncated_reply_reports_eof() {
        let (client, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(&[0, 0, 0, 3, b'a']).unwrap();
        drop(peer);
        let mut client =
            DeadlineStream::new(client, Instant::now() + Duration::from_secs(10)).unwrap();
        assert_eq!(
            read_frame(&mut client).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
