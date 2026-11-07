// When a process started, as the kernel stamps it: the token `ps -o lstart=`
// prints under `LC_ALL=C TZ=UTC` (`Fri Nov  6 02:12:23 2026`), which is what
// Claude Code writes as its record's `procStart`. The daemon compares the two by
// string equality (src/daemon/lane-edge.ts), so this renders that token exactly
// and never a near form.
//
// [LAW:effects-at-boundaries] The kernel read is the one effect; the rendering
// is a pure function of seconds since the epoch, so a test pins it.

// The token for `secs` seconds since the epoch, in UTC: `%a %b %e %H:%M:%S %Y`
// with the C locale's names, the day of the month padded with a space.
pub fn lstart_token(secs: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = secs.div_euclid(86_400);
    let of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{} {} {:>2} {:02}:{:02}:{:02} {}",
        DAYS[days.rem_euclid(7) as usize],
        MONTHS[(month - 1) as usize],
        day,
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
        year
    )
}

// The proleptic Gregorian date of the day `days` after 1970-01-01 (Howard
// Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

// The start of process `pid` in seconds since the epoch, as the kernel stamps
// it, or why it could not be read.
#[cfg(target_os = "macos")]
pub fn start_secs(pid: u32) -> Result<i64, String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
            size,
        )
    };
    if read == size {
        Ok(info.pbi_start_tvsec as i64)
    } else {
        Err(format!(
            "proc_pidinfo({pid}) read {read} of {size} bytes: {}",
            std::io::Error::last_os_error()
        ))
    }
}

// Linux keeps a process's start in clock ticks since boot; `ps` adds the boot
// time and truncates to the second, and so does this, so both name one second.
#[cfg(target_os = "linux")]
pub fn start_secs(pid: u32) -> Result<i64, String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|e| format!("/proc/{pid}/stat: {e}"))?;
    // The command name is parenthesised and may hold spaces or parentheses,
    // so the fields are counted from the last `)`: starttime is the 22nd field,
    // the 20th after it.
    let ticks: i64 = stat
        .rsplit_once(')')
        .and_then(|(_, rest)| rest.split_whitespace().nth(19))
        .and_then(|field| field.parse().ok())
        .ok_or_else(|| format!("/proc/{pid}/stat names no start time"))?;
    let proc_stat =
        std::fs::read_to_string("/proc/stat").map_err(|e| format!("/proc/stat: {e}"))?;
    let boot: i64 = proc_stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))
        .and_then(|secs| secs.trim().parse().ok())
        .ok_or_else(|| "/proc/stat names no boot time".to_string())?;
    let hertz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hertz <= 0 {
        return Err(format!("sysconf(_SC_CLK_TCK) = {hertz}"));
    }
    Ok(boot + ticks / hertz as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pairs read off this machine's process table (`ps -o lstart=` under
    // LC_ALL=C TZ=UTC) and the boundaries a hand-rolled calendar gets wrong.
    #[test]
    fn renders_the_token_ps_prints() {
        assert_eq!(lstart_token(1_793_931_143), "Fri Nov  6 02:12:23 2026");
        assert_eq!(lstart_token(0), "Thu Jan  1 00:00:00 1970");
        assert_eq!(lstart_token(951_782_400), "Tue Feb 29 00:00:00 2000");
        assert_eq!(lstart_token(1_735_689_599), "Tue Dec 31 23:59:59 2024");
        assert_eq!(lstart_token(1_798_761_600), "Fri Jan  1 00:00:00 2027");
    }

    #[test]
    fn reads_its_own_start_as_ps_does() {
        let me = std::process::id();
        assert_eq!(
            lstart_token(start_secs(me).expect("readable")),
            crate::launch::ps_lstart(me)
        );
    }
}
