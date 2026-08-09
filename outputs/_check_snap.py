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
sql = "SELECT elem->>'bond_code' as bc, elem->>'stock_name' as sn, elem->>'safety' as s, elem->>'interest_coverage' as ic, elem->>'cash_coverage' as cc, elem->>'liability_market_ratio' as lmr FROM bond_safety_snapshots, jsonb_array_elements(data) as elem WHERE elem->>'bond_code' LIKE '113049%' ORDER BY elem->>'safety' DESC LIMIT 5"
stdin, stdout, stderr = c.exec_command(f"sudo -u postgres psql -d portfolio -c \"{sql}\"")
print(stdout.read().decode())
c.close()
