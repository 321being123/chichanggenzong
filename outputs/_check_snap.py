import paramiko
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('82.156.125.47', username='ubuntu', password='dai.1234')
sql = "SELECT elem->>'bond_code' as bc, elem->>'stock_name' as sn, elem->>'safety' as s, elem->>'interest_coverage' as ic, elem->>'cash_coverage' as cc, elem->>'liability_market_ratio' as lmr FROM bond_safety_snapshots, jsonb_array_elements(data) as elem WHERE elem->>'bond_code' LIKE '113049%' ORDER BY elem->>'safety' DESC LIMIT 5"
stdin, stdout, stderr = c.exec_command(f"sudo -u postgres psql -d portfolio -c \"{sql}\"")
print(stdout.read().decode())
c.close()
