const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/text');

test('dictionary parses words and replacements, applies whole-word replacements', () => {
  const d = T.parseDictionary('# comment\nNeuralSyntax\nneural syntax => NeuralSyntax\nkush luck => Khushluck');
  assert.deepStrictEqual([...d.words].sort(), ['Khushluck', 'NeuralSyntax']);
  assert.strictEqual(T.applyReplacements('hi from Neural Syntax and kush luck', d.map), 'hi from NeuralSyntax and Khushluck');
  assert.strictEqual(T.applyReplacements('unneural syntaxes', d.map), 'unneural syntaxes');
  assert.strictEqual(T.whisperPrompt(d), 'NeuralSyntax, Khushluck');
  assert.strictEqual(T.whisperPrompt({ words: [], map: [] }), '');
});

test('snippets match whole utterances only', () => {
  const sn = T.parseSnippets('my email => hello@example.com\nyt intro => Hey guys!\\nWelcome back.');
  assert.strictEqual(T.matchSnippet('My email.', sn), 'hello@example.com');
  assert.strictEqual(T.matchSnippet('insert yt intro', sn), 'Hey guys!\nWelcome back.');
  assert.strictEqual(T.matchSnippet('send it to my email please', sn), null);
});

test('whole-utterance voice commands', () => {
  assert.strictEqual(T.parseCommand('Scratch that.'), 'undo');
  assert.strictEqual(T.parseCommand('press enter'), 'enter');
  assert.strictEqual(T.parseCommand('new line'), 'enter');
  assert.strictEqual(T.parseCommand('select all'), 'selectAll');
  assert.strictEqual(T.parseCommand('please delete that file'), null);
});

test('inline commands become punctuation / line breaks', () => {
  assert.strictEqual(T.applyInlineCommands('Hello comma how are you question mark'), 'Hello, how are you?');
  assert.strictEqual(T.applyInlineCommands('Hello, comma, how are you?'), 'Hello, how are you?');
  assert.strictEqual(T.applyInlineCommands('first line new line second line'), 'first line\nsecond line');
  assert.strictEqual(T.applyInlineCommands('para one new paragraph para two'), 'para one\n\npara two');
  assert.strictEqual(T.applyInlineCommands('no commands here'), 'no commands here');
});

test('per-app tone rules', () => {
  const rules = 'slack=casual\ncode=code\ntitle:gmail=formal\n# note\noutlook=formal';
  assert.strictEqual(T.toneForApp({ name: 'slack', title: '' }, rules), 'casual');
  assert.strictEqual(T.toneForApp({ name: 'Visual Studio Code', title: '' }, rules), 'code');
  assert.strictEqual(T.toneForApp({ name: 'Code', title: '' }, rules), 'code');
  assert.strictEqual(T.toneForApp({ name: 'chrome', title: 'Inbox - Gmail' }, rules), 'formal');
  assert.strictEqual(T.toneForApp({ name: 'chrome', title: 'YouTube' }, rules, 'neutral'), 'neutral');
  assert.strictEqual(T.toneForApp({ name: 'decoder', title: '' }, rules), 'neutral'); // no substring false-positive
  assert.strictEqual(T.toneForApp(null, rules, 'casual'), 'casual');
});
