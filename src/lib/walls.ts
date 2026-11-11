import type { CollectionEntry } from "astro:content";

type Streetart = CollectionEntry<"streetarts">;
type Wall = CollectionEntry<"walls">;

// <town>-wNNN: lowercase ASCII town slug, then "-w" and at least 3 digits.
export const WALL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-w\d{3,}$/;

export interface WallMember {
  id: string;
  // Position of the entry in the gallery, as passed to getWallMembers.
  index: number;
  pubDate: Date;
}

export interface WallInfo {
  wallId: string;
  // All photos of the wall, pubDate ascending, then entry id.
  members: WallMember[];
  // 0-based position of this entry in `members`.
  position: number;
  total: number;
}

function compareMembers(a: WallMember, b: WallMember): number {
  const byDate = a.pubDate.getTime() - b.pubDate.getTime();
  if (byDate !== 0) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Groups street-art entries by wall.
 * `entries` must be in gallery order: an entry's index in this array is the
 * `data-index` of its Detail. Returns one WallInfo per entry that has a wall,
 * keyed by entry id. Entries without a wall are absent from the map.
 */
export function getWallMembers(entries: Streetart[]): Map<string, WallInfo> {
  const byWall = new Map<string, WallMember[]>();
  entries.forEach((entry, index) => {
    const wallId = entry.data.wall?.id;
    if (!wallId) return;
    const members = byWall.get(wallId) ?? [];
    members.push({ id: entry.id, index, pubDate: entry.data.pubDate });
    byWall.set(wallId, members);
  });

  const result = new Map<string, WallInfo>();
  for (const [wallId, members] of byWall) {
    members.sort(compareMembers);
    members.forEach((member, position) => {
      result.set(member.id, { wallId, members, position, total: members.length });
    });
  }
  return result;
}

/**
 * Build-time consistency checks between street-art entries and wall files.
 * Throws (fails the build) on a dangling reference or a malformed wall id.
 * Warns on a wall file that no photo references.
 * A wall with a single photo is normal and is not reported.
 */
export function checkWalls(entries: Streetart[], walls: Wall[]): void {
  const errors: string[] = [];
  const wallIds = new Set(walls.map((wall) => wall.id));
  const referenced = new Set<string>();

  for (const wall of walls) {
    if (!WALL_ID_PATTERN.test(wall.id)) {
      errors.push(`wall file "${wall.id}": id does not match <town>-wNNN`);
    }
  }

  for (const entry of entries) {
    const wallId = entry.data.wall?.id;
    if (!wallId) continue;
    referenced.add(wallId);
    if (!WALL_ID_PATTERN.test(wallId)) {
      errors.push(`streetart "${entry.id}": wall "${wallId}" does not match <town>-wNNN`);
    }
    if (!wallIds.has(wallId)) {
      errors.push(`streetart "${entry.id}": wall "${wallId}" has no file in src/content/walls/`);
    }
  }

  for (const wallId of wallIds) {
    if (!referenced.has(wallId)) {
      console.warn(`[walls] wall "${wallId}" is referenced by no photo`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`[walls] ${errors.length} problem(s):\n- ${errors.join("\n- ")}`);
  }
}
