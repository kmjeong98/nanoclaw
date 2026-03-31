import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  it('Discord JID: starts with dc:', () => {
    const jid = 'dc:1234567890123456';
    expect(jid.startsWith('dc:')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'dc:1234567890',
      '2024-01-01T00:00:01.000Z',
      'Server Channel 1',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:user-dm-123',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'discord',
      false,
    );
    storeChatMetadata(
      'dc:9876543210',
      '2024-01-01T00:00:03.000Z',
      'Server Channel 2',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('dc:1234567890');
    expect(groups.map((g) => g.jid)).toContain('dc:9876543210');
    expect(groups.map((g) => g.jid)).not.toContain('dc:user-dm-123');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'dc:1234567890',
      '2024-01-01T00:00:01.000Z',
      'Channel',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('dc:1234567890');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'dc:reg-123',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:unreg-456',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'discord',
      true,
    );

    _setRegisteredGroups({
      'dc:reg-123': {
        name: 'Registered',
        folder: 'discord_registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'dc:reg-123');
    const unreg = groups.find((g) => g.jid === 'dc:unreg-456');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'dc:old-1',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:new-1',
      '2024-01-01T00:00:05.000Z',
      'New',
      'discord',
      true,
    );
    storeChatMetadata(
      'dc:mid-1',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('dc:new-1');
    expect(groups[1].jid).toBe('dc:mid-1');
    expect(groups[2].jid).toBe('dc:old-1');
  });

  it('excludes non-group chats regardless of JID format', () => {
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    storeChatMetadata(
      'dc:group-1',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'discord',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('dc:group-1');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
