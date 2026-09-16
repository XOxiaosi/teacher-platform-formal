/**
 * Pure backup retention planning.  The planner never reads or mutates storage;
 * callers can therefore use it for a dry run without exposing backup content.
 */

const DUMP_RE = /^(.+)_([0-9]{8})-([0-9]{6})\.(?:dump|tar)$/;
const MANIFEST_RE = /^MANIFEST-([0-9]{8})(?:[-T])([0-9]{6})\.json$/;
const ISO_RE = /([0-9]{8})[-T]([0-9]{6})/;

function parseStamp(value) {
  const dump = DUMP_RE.exec(value);
  const manifest = MANIFEST_RE.exec(value);
  const isoMatch = ISO_RE.exec(value);
  const ymd = dump?.[2] ?? manifest?.[1] ?? isoMatch?.[1];
  const hms = dump?.[3] ?? manifest?.[2] ?? isoMatch?.[2];
  if (!ymd || !hms) return null;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}.000Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== iso) return null;
  return date;
}

function itemTimestamp(item) {
  if (item.timestamp instanceof Date) return new Date(item.timestamp.getTime());
  if (typeof item.timestamp === 'string') {
    const date = new Date(item.timestamp);
    if (!Number.isNaN(date.getTime()) && date.toISOString() === item.timestamp) return date;
    return null;
  }
  const key = typeof item.key === 'string' ? item.key.split('/').at(-1) : '';
  return parseStamp(key);
}

function reasonFor(kind, ageDays, maxAgeDays) {
  if (kind === 'unknown') return '无法识别的备份格式';
  if (ageDays < 0) return '备份时间晚于可信当前时间';
  if (ageDays >= maxAgeDays) return `已达到 ${maxAgeDays} 天保留期限`;
  return `未达到 ${maxAgeDays} 天保留期限`;
}

/**
 * Plan retention for an inventory of backup artifacts.
 *
 * Each item is `{key, kind, timestamp, groupKey}`.  Items in one group are
 * expired together.  A malformed, future, or unknown member blocks the whole
 * group so a partial backup cannot be removed accidentally.
 */
export function planRetention(inventory, { now = new Date(), maxAgeDays = 30 } = {}) {
  if (!Array.isArray(inventory)) throw new TypeError('retention inventory must be an array');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('retention now must be a valid Date');
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) throw new RangeError('maxAgeDays must be 1..3650');
  const groups = new Map();
  const normalized = inventory.map((item, index) => {
    const key = typeof item?.key === 'string' && item.key.length > 0 ? item.key : `#${index}`;
    const date = itemTimestamp(item ?? {});
    const kind = item?.kind === 'dump' || item?.kind === 'manifest' || item?.kind === 'media'
      ? item.kind : 'unknown';
    const groupKey = typeof item?.groupKey === 'string' && item.groupKey.length > 0
      ? item.groupKey : key;
    const ageDays = date ? (now.getTime() - date.getTime()) / 86400000 : null;
    const row = { key, kind, groupKey, occurredAt: date?.toISOString() ?? null, ageDays, status: 'blocked', reason: reasonFor(kind, ageDays ?? Number.NaN, maxAgeDays) };
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(row);
    return row;
  });
  for (const rows of groups.values()) {
    const malformed = rows.some((row) => row.occurredAt === null || row.ageDays < 0 || row.kind === 'unknown');
    const expired = rows.some((row) => row.ageDays >= maxAgeDays);
    for (const row of rows) {
      if (malformed) {
        row.status = 'blocked';
        if (row.occurredAt !== null && row.ageDays >= 0 && row.kind !== 'unknown') {
          row.reason = '备份组含无法核对的成员，保留整组';
        }
      } else if (expired) {
        row.status = 'expire';
      } else {
        row.status = 'retain';
      }
    }
  }
  return {
    now: now.toISOString(),
    maxAgeDays,
    items: normalized,
    retain: normalized.filter((row) => row.status === 'retain').map((row) => row.key),
    expire: normalized.filter((row) => row.status === 'expire').map((row) => row.key),
    blocked: normalized.filter((row) => row.status === 'blocked').map((row) => row.key),
  };
}

export function retentionTimestampFromKey(key) {
  if (typeof key !== 'string') return null;
  return parseStamp(key.split('/').at(-1));
}
