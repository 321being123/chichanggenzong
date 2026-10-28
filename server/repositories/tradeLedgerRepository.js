

// 自 server/services/tradeLedger.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function heldQuantity(client, username, accountName, code) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS qty FROM positions
      WHERE username=$1 AND account_name=$2 AND code=$3`,
    [username, accountName, code]
  );
  return Number(rows[0] ? rows[0].qty : 0);
}

module.exports = {
  heldQuantity,
};
