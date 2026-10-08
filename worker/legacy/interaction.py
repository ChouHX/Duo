"""Explicit UI boundary. The CLI remains usable when no desktop handler is bound."""
import builtins

handler = None


def text_input(label=''):
    if handler is None:
        return builtins.input(label)
    return handler.text(label)


def report_stage(stage, **data):
    if handler is not None:
        handler.stage(stage, **data)
