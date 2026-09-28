import path from 'node:path';

export function resolveRefundLogPath(env = process.env) {
  const explicit = env.REFUND_LOG_PATH?.trim();
  if (explicit) {
    return {
      logPath: path.resolve(explicit),
      mode: 'explicit',
      persistent: Boolean(env.RAILWAY_VOLUME_MOUNT_PATH)
        && path.resolve(explicit).startsWith(path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH)),
    };
  }

  const railwayMount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayMount) {
    return {
      logPath: path.join(path.resolve(railwayMount), 'refunds.jsonl'),
      mode: 'railway-volume',
      persistent: true,
    };
  }

  return {
    logPath: path.resolve('./data/refunds.jsonl'),
    mode: 'ephemeral',
    persistent: false,
  };
}
