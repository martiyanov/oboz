#!/usr/bin/env python3
"""Smoke-тест TUI: запускает oboz в псевдотерминале, шлёт клавиши, снимает экраны.

Использование: python3 scripts/tui-smoke.py [--empty]
"""
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]')
ROWS, COLS = 42, 112


def spawn(args):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp(args[0], args)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
    return pid, fd


def read_for(fd, seconds):
    data = b''
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
    return data


def screen(data):
    text = ANSI.sub(b'', data).decode('utf-8', 'replace')
    # Берём последний кадр: всё после последней очистки экрана.
    frames = text.split('\x1b[2J')
    text = frames[-1] if len(frames) > 1 else text
    lines = [line.rstrip() for line in text.replace('\r', '').split('\n')]
    # Убираем пустой хвост
    while lines and not lines[-1]:
        lines.pop()
    return '\n'.join(lines)


def main():
    empty_mode = '--empty' in sys.argv
    args = ['./oboz', 'tui', '--demo']
    if empty_mode:
        args += ['--threshold', '0.95']
    pid, fd = spawn(args)
    steps = []
    try:
        steps.append(('стартовый экран', read_for(fd, 2.0)))
        if not empty_mode:
            os.write(fd, b'\r')
            steps.append(('Enter: досье события', read_for(fd, 1.2)))
            os.write(fd, b'\x1b[B\x1b[B\x1b[B\x1b[B')  # 4 вниз: первые источники
            steps.append(('4×вниз в досье', read_for(fd, 0.8)))
            os.write(fd, b'\r')
            steps.append(('Enter: карточка источника', read_for(fd, 0.8)))
            os.write(fd, b'\x1b')
            os.write(fd, b'\x1b')
            steps.append(('Esc×2: назад в список', read_for(fd, 0.8)))
            os.write(fd, b't')
            steps.append(('t: порог +0.05', read_for(fd, 0.8)))
        else:
            os.write(fd, b't')
            steps.append(('t: повышение порога на пустом экране', read_for(fd, 0.8)))
        os.write(fd, b'q')
        read_for(fd, 0.4)
    finally:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)

    for title, data in steps:
        print(f'\n===== {title} =====')
        print(screen(data))


if __name__ == '__main__':
    main()
