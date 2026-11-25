import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creativeWorkSchema } from '../src/mastra/tools/creative-work.ts';

const script = {
  kind: 'script',
  title: 'Salt',
  start: 'start',
  scenes: [
    {
      id: 'start',
      title: 'Table',
      blocks: [{ type: 'action', text: 'A jar slides across the table.' }],
      choices: [
        { label: 'Hide it', to: 'safe' },
        { label: 'Ask the waiter', to: 'caught' },
      ],
    },
    {
      id: 'safe',
      title: 'Clue',
      blocks: [{ type: 'dialogue', speaker: 'Yamada', text: 'We can leave together.' }],
      ending: 'Safe',
    },
    { id: 'caught', title: 'Trap', blocks: [{ type: 'action', text: 'The door locks.' }], ending: 'Caught' },
  ],
};
test('playable previews accept branching paths and merges that reach endings', () => {
  assert.equal(creativeWorkSchema.safeParse(script).success, true);
  const merged = structuredClone(script);
  merged.scenes[2] = { ...merged.scenes[2], ending: undefined, choices: [{ label: 'Escape the trap', to: 'safe' }] };
  assert.equal(creativeWorkSchema.safeParse(merged).success, true);
});
for (const [name, mutate] of [
  [
    'missing entry',
    work => {
      work.start = 'missing';
    },
  ],
  [
    'dangling choice',
    work => {
      work.scenes[0].choices[0].to = 'missing';
    },
  ],
  [
    'duplicate scene IDs',
    work => {
      work.scenes[2].id = 'safe';
    },
  ],
  [
    'unreachable scenes',
    work => {
      work.scenes[0].choices.pop();
    },
  ],
  [
    'endless cycles',
    work => {
      work.scenes[1].ending = undefined;
      work.scenes[1].choices = [{ label: 'Again', to: 'start' }];
    },
  ],
  [
    'choices at an ending',
    work => {
      work.scenes[0].ending = 'Done';
    },
  ],
  [
    'dead end without a conclusion',
    work => {
      work.scenes[1].ending = undefined;
    },
  ],
])
  test(`playable previews reject ${name} before displaying a broken path`, () => {
    const work = structuredClone(script);
    mutate(work);
    assert.equal(creativeWorkSchema.safeParse(work).success, false);
  });
test('relationships reference actual, distinct characters and allow several relationships', () => {
  const character = name => ({ name, role: 'hunter', desire: 'escape', obstacle: 'fear', change: 'trust' });
  const work = {
    kind: 'characters',
    title: 'Hunters',
    characters: [character('A'), character('B')],
    relationships: [{ from: 'A', to: 'B', label: 'trust', tension: 'a hidden clue' }],
  };
  assert.equal(creativeWorkSchema.safeParse(work).success, true);
  work.relationships[0].to = 'C';
  assert.equal(creativeWorkSchema.safeParse(work).success, false);
  work.relationships[0].to = 'A';
  assert.equal(creativeWorkSchema.safeParse(work).success, false);
});
test('revision previews allow additions and deletions but reject two empty versions', () => {
  for (const [before, after, valid] of [
    ['', 'new', true],
    ['old', '', true],
    ['', '', false],
  ]) {
    assert.equal(
      creativeWorkSchema.safeParse({ kind: 'revision', title: 'Change', reason: 'Feedback', before, after }).success,
      valid,
    );
  }
});
