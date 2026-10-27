"""What a captured bar may not carry out of the sandbox: the machine it ran on. [LAW:single-enforcer]

The sandbox stops a script reading the host, but the host still shows through what the kernel
answers for free: the user's name and the machine's name from whoami and hostname, and the run
directory's own path from pwd. Each is rewritten to what the same bar would show on the fake
developer's machine. The run path is matched by its tail as well as whole, because a bar that
shortens a path keeps the tail.
"""
import getpass, re, socket

HOME_SHOWN = '/Users/dev'
USER_SHOWN = 'dev'
HOST_SHOWN = 'dev-mac'
_user = getpass.getuser()
_host = socket.gethostname().split('.')[0]


def scrub(text, run):
    text = text.replace(run, HOME_SHOWN)
    tail = run.removeprefix('/private')
    text = text.replace(tail, HOME_SHOWN)
    text = re.sub(r'(?<![\w.-])' + re.escape(_user) + r'(?![\w-])', USER_SHOWN, text)
    text = re.sub(r'(?<![\w.-])' + re.escape(_host) + r'(?![\w-])', HOST_SHOWN, text)
    return text
