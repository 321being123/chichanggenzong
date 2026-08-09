import json
import os

import paramiko

HOST = os.environ.get('SSH_HOST', '82.156.125.47')
USER = os.environ.get('SSH_USER', 'ubuntu')
KEY_PATH = os.environ.get('SSH_KEY_PATH') or os.path.expanduser('~/.ssh/server_login')

c = paramiko.SSHClient()
c.load_system_host_keys()
if os.environ.get('SSH_KNOWN_HOSTS'):
    c.load_host_keys(os.path.expanduser(os.environ['SSH_KNOWN_HOSTS']))
c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(HOST, username=USER, pkey=paramiko.Ed25519Key.from_private_key_file(KEY_PATH),
          look_for_keys=False, allow_agent=False)
for suffix in ['113049', '113049.SH']:
    stdin, stdout, stderr = c.exec_command(f'curl -s http://localhost:3000/api/bond-valuation/bonds/{suffix}')
    j = json.loads(stdout.read().decode())
    print(f'=== {suffix} ===')
    print('  bond_code:', j.get('bond_code'))
    print('  empty:    ', j == {})
    print('  safety:   ', j.get('safety'))
    print('  rating_history_complete:', j.get('credit', {}).get('rating_history_complete'))
    print('  history len:', len(j.get('credit', {}).get('history', [])))
c.close()
