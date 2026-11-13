type Connection = { type?: string; effectiveType?: string; saveData?: boolean };
export const detectNetworkCost = (connection?: Connection) => ({
  supported: Boolean(connection?.type && connection.type !== 'unknown' && connection.type !== 'none'),
  metered: connection?.type === 'cellular' || connection?.saveData === true,
});
