import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  Relations,
  getRelationsMap,
  resolveRelation,
} from '../../src/decorator/relations.decorator.js';

class PostFilter {}
class CommentFilter {}
class FakeEntity {}

@Relations({
  posts: { filter: PostFilter, keys: ['postTitle', 'postStatus'] },
  comments: { filter: CommentFilter, keys: ['commentBody'] },
})
class UserFilter {}

class NoRelationsFilter {}

describe('@Relations decorator', () => {
  it('stores relation metadata on the class', () => {
    const map = getRelationsMap(UserFilter);
    expect(map).toBeDefined();
    expect(map!.posts.filter).toBe(PostFilter);
    expect(map!.posts.keys).toEqual(['postTitle', 'postStatus']);
    expect(map!.comments.filter).toBe(CommentFilter);
    expect(map!.comments.keys).toEqual(['commentBody']);
  });

  it('returns undefined when no @Relations is set', () => {
    expect(getRelationsMap(NoRelationsFilter)).toBeUndefined();
  });

  it('resolveRelation returns the matching relation for a key', () => {
    const result = resolveRelation(UserFilter, 'postTitle');
    expect(result).toBeDefined();
    expect(result![0]).toBe('posts');
    expect(result![1].filter).toBe(PostFilter);
  });

  it('resolveRelation returns undefined for unmapped keys', () => {
    expect(resolveRelation(UserFilter, 'unknownKey')).toBeUndefined();
  });

  it('resolveRelation returns undefined when no @Relations metadata', () => {
    expect(resolveRelation(NoRelationsFilter, 'anything')).toBeUndefined();
  });
});
