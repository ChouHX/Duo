"""Use the OS vault explicitly; never fall back to a plaintext keyring backend."""
import sys


class Vault:
    service = 'com.niulai.desktop'

    def __init__(self):
        self.backend = None
        if sys.platform == 'darwin':
            from keyring.backends.macOS import Keyring
            self.backend = Keyring()
        elif sys.platform == 'win32':
            from keyring.backends.Windows import WinVaultKeyring
            self.backend = WinVaultKeyring()

    def get(self, account_id):
        return self.backend.get_password(self.service, account_id) if self.backend else None

    def save(self, account_id, password):
        if not self.backend:
            raise ValueError('当前系统没有可用的凭据保险库。')
        self.backend.set_password(self.service, account_id, password)

    def delete(self, account_id):
        if self.backend:
            from keyring.errors import PasswordDeleteError
            try:
                self.backend.delete_password(self.service, account_id)
            except PasswordDeleteError:
                # Missing credentials are already cleared; real deletion failures must surface.
                if self.get(account_id) is not None:
                    raise
