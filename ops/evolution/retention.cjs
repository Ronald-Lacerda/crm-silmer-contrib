'use strict';

const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

async function purgeExpiredMessages(prisma, { instance, now = Date.now() }) {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(instance || '') ||
    !Number.isFinite(now) ||
    now <= RETENTION_SECONDS * 1000
  ) {
    throw new Error('EVOLUTION_RETENTION_CONFIGURATION_INVALID');
  }
  // Only the dedicated transport's Message rows are eligible. Official schema
  // cascades MessageUpdate and Media; Instance/Session are never mutation targets.
  return prisma.message.deleteMany({
    where: {
      Instance: { is: { name: instance } },
      messageTimestamp: { lt: Math.floor(now / 1000) - RETENTION_SECONDS },
    },
  });
}

function scheduleRetention(
  prisma,
  { instance, report, schedule = setInterval },
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await purgeExpiredMessages(prisma, { instance });
      report('EVOLUTION_RETENTION_COMPLETED');
    } catch {
      report('EVOLUTION_RETENTION_FAILED');
    } finally {
      running = false;
    }
  };
  const timer = schedule(tick, RETENTION_INTERVAL_MS);
  timer.unref?.();
  return { timer, tick };
}

module.exports = {
  RETENTION_SECONDS,
  RETENTION_INTERVAL_MS,
  purgeExpiredMessages,
  scheduleRetention,
};

if (require.main === module) {
  (async () => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient({ log: [] });
    try {
      await purgeExpiredMessages(prisma, {
        instance: process.env.SILMER_EVOLUTION_INSTANCE,
      });
      process.stdout.write('EVOLUTION_RETENTION_COMPLETED\n');
    } catch {
      process.stderr.write('EVOLUTION_RETENTION_FAILED\n');
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })().catch(() => {
    process.stderr.write('EVOLUTION_RETENTION_FAILED\n');
    process.exitCode = 1;
  });
}
