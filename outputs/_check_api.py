import paramiko, json
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('82.156.125.47', username='ubuntu', password='dai.1234')
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
