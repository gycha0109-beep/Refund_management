import path from 'node:path';

function isUnderRailwayVolume(filePath, env) {
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (!mount) return false;

  const resolvedMount = path.resolve(mount);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile === resolvedMount || resolvedFile.startsWith(`${resolvedMount}${path.sep}`);
}

export function resolveRefundLogPath(env = process.env) {
  const explicit = env.REFUND_LOG_PATH?.trim();
  if (explicit) {
    return {
      logPath: path.resolve(explicit),
      mode: 'explicit',
      persistent: isUnderRailwayVolume(explicit, env),
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

export function resolveActionLogPath(env = process.env) {
  const explicit = env.ACTION_LOG_PATH?.trim();
  if (explicit) {
    return {
      logPath: path.resolve(explicit),
      mode: 'explicit',
      persistent: isUnderRailwayVolume(explicit, env),
    };
  }

  const railwayMount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayMount) {
    return {
      logPath: path.join(path.resolve(railwayMount), 'actions.jsonl'),
      mode: 'railway-volume',
      persistent: true,
    };
  }

  const refundExplicit = env.REFUND_LOG_PATH?.trim();
  if (refundExplicit) {
    const actionPath = path.join(path.dirname(path.resolve(refundExplicit)), 'actions.jsonl');
    return {
      logPath: actionPath,
      mode: 'refund-log-sibling',
      persistent: isUnderRailwayVolume(actionPath, env),
    };
  }

  return {
    logPath: path.resolve('./data/actions.jsonl'),
    mode: 'ephemeral',
    persistent: false,
  };
}
