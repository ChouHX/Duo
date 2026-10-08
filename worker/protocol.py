"""One isolated task per process. Only this module writes to protocol stdout."""
import json
import queue
import sys
import threading
import uuid


class Cancelled(BaseException):
    pass


class Channel:
    def __init__(self, account_id, task_id, output=None):
        self.account_id, self.task_id = account_id, task_id
        self.output = output or sys.stdout
        self.cancelled = threading.Event()
        self.responses = queue.Queue()
        self.lock = threading.Lock()

    def emit(self, kind, **payload):
        event = dict(v=1, account_id=self.account_id, task_id=self.task_id, type=kind, **payload)
        with self.lock:
            self.output.write(json.dumps(event, ensure_ascii=False) + '\n')
            self.output.flush()

    def checkpoint(self):
        if self.cancelled.is_set():
            raise Cancelled()

    def receive(self, message):
        if (message.get('account_id') != self.account_id or message.get('task_id') != self.task_id):
            return
        if message.get('type') == 'cancel':
            self.cancelled.set()
            self.responses.put(None)
        elif message.get('type') == 'reply':
            self.responses.put(message)

    def read_replies(self, source):
        try:
            for line in source:
                if len(line) > 1_048_576:
                    break
                try:
                    self.receive(json.loads(line))
                except (ValueError, AttributeError):
                    continue
        finally:
            self.cancelled.set()
            self.responses.put(None)

    def prompt(self, kind, label, **fields):
        self.checkpoint()
        request_id = str(uuid.uuid4())
        self.emit('prompt', prompt=dict(id=request_id, kind=kind, label=label, **fields))
        while True:
            response = self.responses.get()
            self.checkpoint()
            if response and response.get('request_id') == request_id:
                return response.get('value')


class LogStream:
    def __init__(self, channel):
        self.channel, self.buffer = channel, ''

    def write(self, text):
        self.buffer += text
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            if line.strip():
                self.channel.emit('log', message=line[:2000])
        return len(text)

    def flush(self):
        pass

    def isatty(self):
        return False
