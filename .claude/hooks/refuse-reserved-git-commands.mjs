// ABOUTME: Claude Code's PreToolUse gate on Bash. Refuses reserved git spellings and literal
// pushes to the default branch, whose name it reads from the local remote HEAD.
// Reads the hook payload on stdin; prints a deny decision, or nothing when it has no objection.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EVENT = 'PreToolUse';

// A permission rule is a lexical prefix, so it can say "this command" and "anything starting with
// this text", and cannot say "this command with any argument except these". That is the control
// AGENTS.md asks for, so it is made here instead.

// Two refusals, because either alone can be lost. The decision carries the reason; exit 2 blocks
// even where the decision is not read, and an exit code Claude Code does not recognise lets the
// command through.
function refuse(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: EVENT,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** No objection. The permission rules and the prompt decide from here. */
function stepAside() {
  process.exit(0);
}

class Unreadable extends Error {}

const OPERATORS = ['&&', '||', ';', '|', '&', '\n'];

/**
 * Bash's two-character redirection operators whose second character is also the spelling of a
 * control operator. Read as one token, or the operator list above claims the second character and
 * divides a command where bash divides none.
 */
const REDIRECTION_OPERATOR = new Set(['<&', '>&', '>|']);

// Bash owns what a here-document is. This is a copy of the part of that rule the gate needs, so
// this is where the copy can disagree with bash, and what it does about each disagreement.
//
// A `<<` opens a here-document only where bash reads a command's words, and only where a
// redirection may begin. Skipping a body is the gate choosing not to read text, so a `<<` this
// lexer honours and bash ignores skips commands bash goes on to run — which is why the notion of
// where one can open must not exceed bash's. Bash reads no command word inside a quoted string,
// a comment, an arithmetic expression, a parameter expansion or a backtick substitution. The
// first, second, third and fifth the lexer takes whole. The fourth, and `$[ ]` with it, are not
// modelled: instead this gate honours a `<<` only where the word being read is empty or is the
// file descriptor it redirects, which places a `<<` inside any word-internal construct out of
// reach without modelling any of them. That list was taken from bash by running it, and `[[ ]]`
// and a `case` pattern are absent from it because bash rejects a `<<` in either.
//
// That placement rule is narrower than bash's, which is a cost rather than a claim about bash:
// bash ends a word at `<` and `>`, so it begins a redirection straight after another
// redirection's target, and `cat >out<<EOF` is a here-document to bash and unreadable here. It is
// kept narrow deliberately. Honouring a `<<` because its word began with a redirection would
// honour `echo >${x:-<<W}` too, where bash reads no redirection at all and runs what follows —
// measured, and the reason the rule is not widened to the target.
//
// Where the copy still disagrees, it refuses:
//   - A body bash would end at end of input. Bash warns and runs the command; a permission
//     decision has no warning to give, and the alternative is skipping to the end of the text.
//   - A `<<` this gate cannot place: inside a word, as in `cat foo<<EOF`, `a=1<<EOF` and
//     `let x=1<<EOF`, and directly after a redirection, as in `cat >out<<EOF` and `cat <<A<<B`.
//     Bash makes every one of those a here-document. The gate cannot tell them apart from a `<<`
//     inside a construct of that word, so all of them are unreadable here.
//   - `$( (subshell) )`, whose first `)` this lexer pairs with the `$(`. Nothing is skipped.
//
// And one disagreement it does not settle by refusing, because it never did: the gate reads
// inside no command substitution and no subshell as commands, so `$(git push --force)`, its
// backtick spelling, and `( git push --force )` are all permitted and all run. That predates this
// lexer, is card #84, and nothing here widens or narrows it.

/** Where bash ends an unquoted word: a blank, or one of the characters that begin an operator. */
const METACHARACTER = /[ \t\n|&;()<>]/;

/**
 * Read the delimiter word of a here-document, from the first character after `<<` or `<<-`.
 *
 * Bash ends that word at an unquoted metacharacter and removes its quoting to get the delimiter,
 * so `<<'EOF'`, `<<"EOF"` and `<<\EOF` all close on a line reading `EOF`. Blanks may separate the
 * word from the operator.
 */
function delimiterAt(text, start) {
  let i = start;
  while (text[i] === ' ' || text[i] === '\t') i++;
  let delimiter = '';

  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) throw new Unreadable('the command has an unbalanced quote');
      delimiter += text.slice(i + 1, close);
      i = close;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      delimiter += text[++i];
      continue;
    }
    if (METACHARACTER.test(ch)) break;
    delimiter += ch;
  }

  if (!delimiter) throw new Unreadable('a here-document names no delimiter');
  return { delimiter, end: i };
}

/**
 * A line with its ending removed. A line feed ends a line, and *every* carriage return before that
 * line feed belongs to the ending rather than to the text: bash closes a body named `W` on a line
 * reading `W`, `W\r`, `W\r\r` and so on without limit, so the rule is a run of them and not one.
 * Measured on this machine to a depth of six.
 *
 * A run of carriage returns only. A trailing space or tab closes no body, measured the same way,
 * so this takes carriage returns rather than trailing whitespace — trimming whitespace would close
 * bodies bash leaves open.
 *
 * Reading any of that run as text is how a body comes to be read as continuing past the line bash
 * ended it at, with the commands after it skipped. Stripping the whole run can only end a body
 * earlier, which surfaces more text as commands and can hide none.
 */
const withoutEnding = (line) => line.replace(/\r+$/, '');

/**
 * Skip the bodies the here-documents on the line just ended will be fed. A body is data on
 * standard input: it ends at a line that is exactly the delimiter, nothing in it is ever run, and
 * so nothing in it is read as shell text. `<<-` strips leading tabs from the body lines and from
 * that closing line.
 *
 * A body with no closing line is unreadable rather than skipped. Bash ends such a body at end of
 * input and runs the command anyway; refusing instead is the safe half of that disagreement,
 * because a `<<` this gate reads and bash does not cannot then swallow the commands after it.
 */
function skipBodies(text, start, pending) {
  let i = start;
  for (const { delimiter, stripTabs } of pending) {
    const closing = withoutEnding(delimiter);
    for (;;) {
      if (i >= text.length) throw new Unreadable('a here-document has no closing delimiter');
      const breakAt = text.indexOf('\n', i);
      const end = breakAt === -1 ? text.length : breakAt;
      const read = withoutEnding(text.slice(i, end));
      const line = stripTabs ? read.replace(/^\t+/, '') : read;
      i = breakAt === -1 ? end : breakAt + 1;
      if (line === closing) break;
      if (breakAt === -1) throw new Unreadable('a here-document has no closing delimiter');
    }
  }
  return i;
}

/**
 * The index of the parenthesis that closes an arithmetic expression, given the index of the first
 * of the two that open it — `$((` and `((` alike.
 *
 * `<<` inside either is bash's left shift rather than a redirection, so the expression is taken
 * whole and nothing in it is lexed. One that never closes is unreadable.
 */
function arithmeticEnd(text, firstParen) {
  let depth = 0;
  for (let i = firstParen; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  throw new Unreadable('the command has an unclosed arithmetic expression');
}

/**
 * Split a command line into the separate commands it runs, each as a token list, honouring quotes
 * and backslash escapes. An unbalanced quote is unreadable rather than a guess.
 */
function commandsIn(text) {
  const commands = [];
  let tokens = [];
  let token = '';
  let open = false; // a token is open even when it lexed to the empty string, as "" does
  let quote = null;
  let word = ''; // the word being read, which is what says whether a redirection may begin here
  const pending = []; // the here-documents opened on the line being read, in the order bash feeds them
  const suspended = []; // the quote each open `$(` interrupted, restored when it closes
  let quotedSubst = 0; // how many of those quotes were real, so the text is inside one after all

  // A token is what the rules are read against; a word is bash's grammar. They differ, because
  // quoting leaves the token and never the word: `""` lexes to an empty token and a real word.
  const add = (read) => {
    token += read;
    word += read;
    open = true;
  };
  const endToken = () => {
    if (open) tokens.push(token);
    token = '';
    word = '';
    open = false;
  };
  const endCommand = () => {
    endToken();
    if (tokens.length) commands.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Arithmetic, in the `$(( ))` expansion form and in the `((  ))` command form. Read before the
    // quote state, because an expansion is inside double quotes as often as outside them, and is
    // not shell text in either place. The command form only begins where a command may.
    if ((quote === null || quote === '"') && text.startsWith('$((', i)) {
      const end = arithmeticEnd(text, i + 1);
      add(text.slice(i, end + 1));
      i = end;
      continue;
    }
    if (quote === null && word === '' && text.startsWith('((', i)) {
      const end = arithmeticEnd(text, i);
      add(text.slice(i, end + 1));
      i = end;
      continue;
    }
    // A comment runs to the end of the line and bash reads no word in any of it. The line feed is
    // left to the loop, because a here-document opened earlier on this line takes its body after
    // it — `cat <<EOF # a note` is one here-document and one comment.
    if (quote === null && word === '' && ch === '#') {
      const breakAt = text.indexOf('\n', i);
      i = (breakAt === -1 ? text.length : breakAt) - 1;
      continue;
    }
    // A backtick substitution looks for its own here-document bodies inside itself, so a `<<` in
    // one takes nothing from the lines after it. Taken whole, as `$( )`'s contents already are.
    if (quote === null && ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) throw new Unreadable('the command has an unclosed backtick substitution');
      add(text.slice(i, close + 1));
      i = close;
      continue;
    }

    // `$( )` is a command in its own right, and stays one inside double quotes, so a `<<` in it
    // opens a real here-document. Its text is still collected into the word being built, because
    // the words around a substitution belong to the command that wrote it.
    if ((quote === null || quote === '"') && ch === '$' && text[i + 1] === '(') {
      suspended.push(quote);
      if (quote !== null) quotedSubst++;
      quote = null;
      add('$(');
      i++;
      continue;
    }

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) add(text[++i]);
      else if (ch === quote) {
        quote = null;
        open = true;
      } else add(ch);
      continue;
    }

    if (ch === ')' && suspended.length) {
      quote = suspended.pop();
      if (quote !== null) quotedSubst--;
      add(')');
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      // The quoting marks the word without entering the token, which is where it is stripped.
      word += ch;
      open = true;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      add(text[++i]);
      continue;
    }
    // `<&`, `>&` and `>|` are single redirection operators to bash, so the `&` or `|` in one is no
    // control operator and divides no commands. Read here, before the operator list below can
    // split `2>&1` into `2>` and `1`, or `>| out` into `>` and `out`, and leave the program of
    // `2>&1 git push --force` in a command of its own behind a bare descriptor. The operators
    // written out of operator characters entirely — `<<`, `>>`, `<>` — never had the problem.
    //
    // This narrows what counts as an operator, so text that was two commands becomes one and the
    // words of the second become trailing words of the first. That can hide nothing: a command's
    // program is its first word, and none of these operators had a program after it in any
    // spelling — measured, and the pull request reports what bash ran for each. The one other
    // effect is that such a word is no longer empty where a `<<` follows it, so `2>&1<<EOF` turns
    // from a here-document this gate honours into one it cannot place and refuses. That is the
    // direction that skips no text.
    if (REDIRECTION_OPERATOR.has(text.slice(i, i + 2))) {
      add(text.slice(i, i + 2));
      i++;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      // A here-string carries its data on this line, so it opens no body and skips nothing.
      if (text[i + 2] === '<') {
        add('<<<');
        i += 2;
        continue;
      }
      // Bash begins a redirection at the start of a word, or straight after the file descriptor
      // it redirects, and nowhere else. A `<<` further into a word is inside some construct of
      // that word — `${x:-<<W}`, `$[1<<W]` — and a `<<` this gate cannot place is one it must not
      // skip a body for, because the text it skipped would be commands bash goes on to run.
      if (word !== '' && !/^\d+$/.test(word)) {
        throw new Unreadable('a `<<` appears where a here-document cannot be placed');
      }
      const stripTabs = text[i + 2] === '-';
      const { delimiter, end } = delimiterAt(text, i + (stripTabs ? 3 : 2));
      pending.push({ delimiter, stripTabs });
      // The redirection stays in the token list rather than being dropped, because a word removed
      // here is a word an option that takes a value would swallow from further along the command.
      add((stripTabs ? '<<-' : '<<') + delimiter);
      i = end - 1;
      continue;
    }
    if (ch === '\n' && pending.length) {
      i = skipBodies(text, i + 1, pending) - 1;
      pending.length = 0;
      word = '';
      if (!quotedSubst) endCommand();
      continue;
    }
    if (quotedSubst) {
      token += ch;
      open = true;
      // A substitution inside double quotes stands where one word does, so its blanks and its
      // operators divide no commands. They still divide its words, which is what places a `<<`.
      if (ch === ' ' || ch === '\t' || ch === '\n' || OPERATORS.includes(ch)) word = '';
      else word += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken();
      continue;
    }
    if (OPERATORS.includes(text.slice(i, i + 2))) {
      endCommand();
      i++;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      endCommand();
      continue;
    }

    add(ch);
  }

  if (quote) throw new Unreadable('the command has an unbalanced quote');
  if (suspended.length) throw new Unreadable('the command has an unclosed command substitution');
  if (pending.length) throw new Unreadable('a here-document has no closing delimiter');
  endCommand();
  return commands;
}

const basename = (word) => word.split(/[\\/]/).pop();

/** Git's options that sit before the subcommand and swallow the word after them. */
const GIT_GLOBALS_TAKING_A_VALUE = new Set([
  '-c',
  '-C',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--work-tree',
]);

/** Each subcommand's options that swallow the word after them, so a value is never read as a flag. */
const VALUE_OPTIONS = {
  commit: {
    long: new Set([
      '--author',
      '--cleanup',
      '--date',
      '--file',
      '--fixup',
      '--message',
      '--pathspec-from-file',
      '--reedit-message',
      '--reuse-message',
      '--squash',
      '--template',
      '--trailer',
    ]),
    short: new Set(['m', 'F', 'C', 'c', 't']),
  },
  push: {
    long: new Set(['--exec', '--push-option', '--receive-pack', '--repo']),
    short: new Set(['o']),
  },
  branch: {
    long: new Set([
      '--contains',
      '--format',
      '--merged',
      '--no-contains',
      '--no-merged',
      '--points-at',
      '--set-upstream-to',
      '--sort',
    ]),
    short: new Set(['u']),
  },
};

const isCluster = (token) => /^-[A-Za-z]+$/.test(token);
const longName = (token) => token.split('=')[0];

/**
 * Walk one git invocation, handing each option and each operand to the caller. Options after a bare
 * `--` are operands, and a value is never offered as an option.
 */
function walkArguments(words, subcommand, onOption, onOperand) {
  const values = VALUE_OPTIONS[subcommand] ?? { long: new Set(), short: new Set() };
  let operandsOnly = false;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    if (operandsOnly || word === '-' || !word.startsWith('-')) {
      onOperand(word);
      continue;
    }
    if (word === '--') {
      operandsOnly = true;
      continue;
    }

    if (word.startsWith('--')) {
      onOption(longName(word), word);
      if (values.long.has(word)) i++;
      continue;
    }

    onOption(word, word);
    if (isCluster(word)) {
      const letters = word.slice(1);
      for (let n = 0; n < letters.length; n++) {
        onOption(`-${letters[n]}`, word);
        if (!values.short.has(letters[n])) continue;
        // Everything after an option that takes a value is that value rather than more flags.
        // `-m"a message"` lexes to one token, and the letters of the message are not options.
        // Where the option is the last letter, the value is the word after it instead.
        if (n === letters.length - 1) i++;
        break;
      }
    }
  }
}

const RESERVED = {
  commit: (option) =>
    // -n is git's own short spelling of --no-verify on commit. On push it means --dry-run, which is
    // why this rule is bound to the subcommand rather than to the flag.
    option === '--no-verify' || option === '-n'
      ? 'a commit that skips the hooks (--no-verify)'
      : null,
  push: (option) =>
    option === '--no-verify'
      ? 'a push that skips the hooks (--no-verify)'
      : option === '--force' || option === '-f' || longName(option) === '--force-with-lease' || longName(option) === '--force-if-includes'
        ? 'a force push'
        : option === '--delete' || option === '-d'
          ? 'deleting a remote branch'
          : null,
  branch: (option) =>
    option === '--delete' || option === '-d' || option === '-D'
      ? 'deleting a branch'
      : null,
};

const PUSH_RESERVED_OPERAND = (word) =>
  word.startsWith('+')
    ? 'a force push (the +refspec form)'
    : word.startsWith(':') && word.length > 1
      ? 'deleting a remote branch (the :branch form)'
      : null;

/** Refuse a refspec that spells the local remote's default branch as its destination. */
function literalDefaultPush(words, cwd) {
  let remote = null;
  const operands = [];
  walkArguments(
    words,
    'push',
    (option, raw) => {
      if (option === '--repo' && raw.startsWith('--repo=')) remote = raw.slice('--repo='.length);
    },
    (operand) => operands.push(operand),
  );
  remote ??= operands.shift();
  if (!remote) return null;

  const named = spawnSync('git', ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], {
    cwd, encoding: 'utf8',
  });
  const prefix = `refs/remotes/${remote}/`;
  const answer = named.stdout?.trim();
  if (named.status !== 0 || !answer?.startsWith(prefix)) return null;
  const branch = answer.slice(prefix.length);
  if (!branch) return null;

  for (const refspec of operands) {
    const colon = refspec.lastIndexOf(':');
    const destination = colon === -1 ? refspec : refspec.slice(colon + 1);
    if (destination === branch || destination === `refs/heads/${branch}`) {
      return `a push to the default branch ${branch}`;
    }
  }
  return null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// A shell keyword is a word, not an operator, so `commandsIn` leaves it as the first word of the
// command bash goes on to run and puts the program in the word after it. `{ git push --force; }`
// is one command whose words are `{`, `git`, `push`, `--force`, and a rule reading word one reads
// the brace. So the words below are stepped over to reach the program, the same way an
// environment assignment already is.
//
// Stepping over a word can only surface a program this gate was not reading, so it adds refusals
// and takes none away. The cost is the other direction: a word stepped over where bash reads no
// command is a refusal bash would not have earned, which is why the list is bash's reserved words
// rather than a guess, and why each entry was run under bash with `git` shadowed by a marker
// before it was added.

/**
 * Bash's reserved words a command may follow directly. Absent, and why: `esac`, `fi`, `done` and
 * `}` end a construct, so a command after one needs an operator first and is already word one;
 * `for` and `select` are followed by a name rather than a command, and `for x in git push --force`
 * is a word list bash runs no git from; `[[` opens a conditional bash runs no command inside. Each
 * of those was measured rather than reasoned about, and the pull request reports what bash ran.
 *
 * `time` is absent for a different reason: it is also the name of a program, so it sits in
 * `PREFIX_PROGRAMS` below, which reaches every spelling this list would — `time -p`, `time --` and
 * `time { … }` alike — and also `/usr/bin/time`, which this list cannot, because it matches a whole
 * word where the prefix list matches a basename. Holding it in both left one of them dead.
 */
const KEYWORDS_A_COMMAND_MAY_FOLLOW = new Set([
  '!',
  '{',
  'coproc',
  'do',
  'elif',
  'else',
  'function',
  'if',
  'in',
  'then',
  'until',
  'while',
]);

/**
 * A redirection where bash reads a command's words. Bash reads one before the program as freely as
 * after it, so `>out git push --force` runs git and the program sits after the redirection. The
 * descriptor is a number or, in bash, a name in braces; the target is in this word or the next one,
 * which is what says how many words to step over.
 *
 * The operators are ordered longest first. A two-character one read as its first character would
 * take `>| out` for a redirection whose target is already in this word and stop before `out`.
 *
 * `<<` and `<<-` are absent because only their length could matter here and neither can reach it:
 * the lexer above never leaves a bare `<<` or `<<-` token, since it reads the delimiter into the
 * same word and refuses a here-document that names none. A `<<EOF` word is matched by `<` and
 * stepped over as a word carrying its own target, which is what it is.
 */
const REDIRECTION = /^(\{[A-Za-z_][A-Za-z0-9_]*\}|\d*)(<<<|<&|>&|<>|>>|>\||<|>)/;

/**
 * Step over the words bash's grammar puts between the start of a command and the program it runs:
 * assignments, reserved words, redirections, and the `case` pattern or `NAME()` header that
 * introduces a body. Returns the words from the program on, which may be none.
 *
 * Everything here is bash's grammar. A program that runs another program named in its arguments is
 * not — `env`, `nohup` and the rest are handled where the program is read, because each has its
 * own option grammar and none of them is the shell's.
 */
function programWords(given) {
  let words = given;
  for (;;) {
    let start = 0;
    while (start < words.length && ASSIGNMENT.test(words[start])) start++;
    words = words.slice(start);
    if (!words.length) return words;
    const first = words[0];

    if (KEYWORDS_A_COMMAND_MAY_FOLLOW.has(first)) {
      words = words.slice(1);
      // `coproc NAME compound` and `function NAME compound` name the thing before its body, so
      // the body's first command is a word further on. Bash reads a NAME only before a compound
      // command: in `coproc c git push --force` the `c` is the program, and bash runs `c`.
      if ((first === 'coproc' || first === 'function') && words[1] === '{') words = words.slice(1);
      continue;
    }
    // `case WORD in` is a header that runs nothing, and a pattern ends at the `)` that introduces
    // its body — on the same line as the body's first command, because `)` is no operator here.
    // The scan runs to the first word ending in `)` rather than testing one word, because the
    // pattern may be several words and may itself hold a `)`.
    if (first === 'case') {
      const pattern = words.findIndex((word, at) => at > 0 && word.endsWith(')'));
      if (pattern === -1) return [];
      words = words.slice(pattern + 1);
      continue;
    }
    // A word ending in `)` where a command may begin is a later `case` branch's pattern, or the
    // `NAME()` header of a function definition. Only the first word is tested: a scan further
    // along would step over `git push --force '--x)'` and reach nothing.
    if (first.endsWith(')')) {
      words = words.slice(1);
      continue;
    }
    // The same pattern with the `)` set off by a blank, which lexes as its own word. Only the
    // second word is read, so a `)` further along a command is not a pattern: `echo ')' hello`,
    // `grep ')'` and `sed 's/x/)/'` are all left alone. The cost is `echo ')' git push --force`,
    // where the second word lexes to exactly `)` once its quoting is removed and this steps over
    // both — a refusal of text bash runs `echo` for, and the only one this rule costs.
    if (words[1] === ')') {
      words = words.slice(2);
      continue;
    }
    // A redirection, which may be written before the program as freely as after it. Written
    // `>out` the target is in this word; written `> out` it is the next one.
    const redirection = REDIRECTION.exec(first);
    if (redirection) {
      words = words.slice(redirection[0].length === first.length ? 2 : 1);
      continue;
    }
    return words;
  }
}

/**
 * Programs that run a command named in their arguments. Stepping over one is not enough, because
 * each has its own options and some take an operand before the command — `timeout 5 git …`,
 * `nice -n 10 git …`, `env -u FOO git …`. Rather than carry an option grammar per program, every
 * word after the prefix is read as a possible start of a command.
 *
 * That reads more words than bash runs, which can only add a refusal: it objects only where the
 * words from one of them on spell a reserved command, so `nohup echo git status` and
 * `command -v git` are untouched while `nohup git push --force` is refused. What it costs is a
 * command whose arguments spell a reserved git command that bash passes to something else, as
 * `nohup echo git push --force` does.
 *
 * `env` was the one name here before this list, and stepping over it was defeated by its own
 * options. These are programs rather than shell grammar, so which of them exists is a fact about
 * the host: a name absent from the host runs nothing, and the pull request records which were
 * watched running git here and which bash reported absent.
 *
 * **This is an enumeration, so a prefix program not named here is fail-open**: the gate reads its
 * first word, finds a name it does not know, and steps aside while bash goes on to run the git
 * command in its arguments. Nothing in the rule closes the family — the names close themselves.
 * A name that belongs here is added here, and no host's list of such programs is knowable from
 * this file.
 */
const PREFIX_PROGRAMS = new Set([
  'chrt',
  'command',
  'doas',
  'env',
  'exec',
  'flock',
  'ionice',
  'nice',
  'nohup',
  'setsid',
  'stdbuf',
  'sudo',
  'taskset',
  'time',
  'timeout',
  'unbuffer',
  'xargs',
]);

/**
 * Options of programs on `PREFIX_PROGRAMS` that carry a **whole command inside one word**. The
 * prefix scan reads every word after the prefix looking for a program, so a command written inside
 * one of those words is a word that is no program and the scan reaches nothing. `env -S` splits the
 * word itself; `flock -c` and `sudo -s` / `-i` hand it to a shell, which is what `sudo`'s manual
 * says of both its flags: if a command is specified, it is passed to the shell for execution via
 * the shell's `-c` option.
 *
 * `letter` matches the short option, allowing for the flags it may sit behind in a cluster; `name`
 * is the long one without its dashes. A program with more than one such option is read once per
 * option, because the options are independent.
 */
const COMMANDS_CARRIED_IN_A_WORD = new Map([
  ['env', [{ letter: /^-[A-Za-z0-9]*S/, name: 'split-string' }]],
  ['flock', [{ letter: /^-[A-Za-z0-9]*c/, name: 'command' }]],
  ['sudo', [
    { letter: /^-[A-Za-z0-9]*s/, name: 'shell' },
    { letter: /^-[A-Za-z0-9]*i/, name: 'login' },
  ]],
]);

/**
 * Every text that option can carry, in the order the words give them.
 *
 * The text may be written in the option's own word — `-S…` and `--split-string=…` — and it may be
 * a word after it: `-S …` and `--split-string …` put it in the next one, and `sudo`'s flags take no
 * argument at all, so the command is an operand and which operand depends on the options between
 * the flag and it. **So every word after the option is read, and every match is read rather than
 * the first.** That reads more words than any of these programs runs, which can only add a
 * refusal — it objects only where the words from one of them on spell a reserved command — and it
 * buys the one thing this host cannot check: nothing here has to know where a program stops
 * parsing options, or which of two `-c` words it would take. `env` takes the first `-S`, which is
 * measured; what `flock` takes is not, and the pull request says which is which.
 *
 * **A long option is matched by any non-empty prefix of its name**, because these programs parse
 * with `getopt_long`, which resolves an unambiguous abbreviation to the option it abbreviates. So
 * `--s=` is `env`'s `--split-string=`, `split-string` being its only long option beginning with
 * `s`, and `--com=` is `flock`'s `--command=`. Which abbreviations are *unambiguous* is the
 * program's own question and is not asked here: a prefix the program would reject as ambiguous is
 * read as this option anyway, which can only add a refusal, and only to text that spells a
 * reserved git command. So can a cluster whose earlier letter takes a value — `-uS` unsets a
 * variable named `S` — for the same reason.
 *
 * The name must be non-empty, because every name begins with the empty string: match a bare `--`
 * and a real option further along goes unread, which is a narrowing rather than a widening.
 */
function commandsCarriedInAWord(words, option) {
  const texts = [];
  for (let at = 1; at < words.length; at++) {
    const word = words[at];
    let inTheWord;
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const written = equals === -1 ? word.slice(2) : word.slice(2, equals);
      if (written.length && option.name.startsWith(written)) {
        inTheWord = equals === -1 ? '' : word.slice(equals + 1);
      }
    }
    if (inTheWord === undefined) {
      const short = option.letter.exec(word);
      if (short) inTheWord = word.slice(short[0].length);
    }
    if (inTheWord === undefined) continue;
    if (inTheWord !== '') texts.push(inTheWord);
    texts.push(...words.slice(at + 1));
  }
  return texts;
}

/** Inspect one command. Returns the reason to refuse, or null. */
function objectionTo(given, depth, cwd) {
  // A command may carry environment assignments and shell keywords before the program it runs:
  // `GIT_AUTHOR_DATE=… git commit …` and `{ git push --force; }` both run git, and neither has it
  // as word one.
  const words = programWords(given);
  if (!words.length) return null;

  // A shell asked to run a command string is that command string; look inside it once.
  const program = basename(words[0]);
  if (SHELLS.has(program) && depth < 2) {
    // -c may be written in a cluster, as `bash -lc "…"`.
    const flag = words.findIndex((word) => word === '-c' || (isCluster(word) && word.includes('c')));
    const script = flag === -1 ? undefined : words[flag + 1];
    if (script !== undefined) {
      for (const inner of commandsIn(script)) {
        const objection = objectionTo(inner, depth + 1);
        if (objection) return objection;
      }
    }
    return null;
  }

  // `eval` joins its arguments with a blank and runs the result as shell text, so no one word is
  // the command it runs and the text is re-read the way a shell's `-c` argument is.
  if (program === 'eval' && depth < 2) {
    for (const inner of commandsIn(words.slice(1).join(' '))) {
      const objection = objectionTo(inner, depth + 1);
      if (objection) return objection;
    }
    return null;
  }

  // `env -S`, `flock -c` and `sudo -s` / `-i` carry the whole command inside one word, so the scan
  // below reads a word that is no program. Each such word's text is re-read instead, the way a
  // shell's `-c` argument and `eval`'s joined arguments already are. The depth is passed on
  // unchanged for the reason the prefix scan below passes it on: none of the three is a shell, and
  // `env -S'bash -c "…"'` has to reach the script. There is no early return, because all three are
  // also ordinary prefixes and `env -u FOO git push --force` is reached by the scan.
  for (const option of COMMANDS_CARRIED_IN_A_WORD.get(program) ?? []) {
    for (const text of commandsCarriedInAWord(words, option)) {
      for (const inner of commandsIn(text)) {
        const objection = objectionTo(inner, depth);
        if (objection) return objection;
      }
    }
  }

  // A program that runs a command named in its arguments. Every word after it is read as a
  // possible command, and each read is of a strictly shorter list, so a chain of prefixes ends.
  // The depth is passed on unchanged, because a prefix is not a shell and must not spend the
  // budget for looking inside one: `sudo bash -c '…'` has to reach the script.
  if (PREFIX_PROGRAMS.has(program)) {
    for (let at = 1; at < words.length; at++) {
      const objection = objectionTo(words.slice(at), depth);
      if (objection) return objection;
    }
    return null;
  }

  if (program !== 'git' && program !== 'git.exe') return null;

  // Step over git's own options to reach the subcommand, and read the config it sets on the way.
  let i = 1;
  let subcommand = null;
  let literalCwd = given[0] === words[0] ? cwd : null;
  for (; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith('-')) {
      subcommand = word;
      i++;
      break;
    }
    literalCwd = null;
    if (word === '-c' || word === '--config-env') {
      const setting = words[i + 1] ?? '';
      if (/^core\.hooksPath\s*=/i.test(setting)) return 'turning the repository hooks off (core.hooksPath)';
      i++;
      continue;
    }
    // git documents --config-env=<name>=<envvar>, so the setting is inside this one word.
    if (word.startsWith('--config-env=')) {
      if (/^core\.hooksPath\s*=/i.test(word.slice('--config-env='.length))) {
        return 'turning the repository hooks off (core.hooksPath)';
      }
      continue;
    }
    if (/^--git-dir=|^--work-tree=|^--namespace=|^--exec-path=/.test(word)) continue;
    if (GIT_GLOBALS_TAKING_A_VALUE.has(word)) i++;
  }

  if (subcommand === null) return null;
  const rule = RESERVED[subcommand];
  if (!rule) return null;

  let objection = null;
  walkArguments(
    words.slice(i),
    subcommand,
    (option) => {
      objection ??= rule(option);
    },
    (operand) => {
      if (subcommand === 'push') objection ??= PUSH_RESERVED_OPERAND(operand);
    },
  );
  if (!objection && subcommand === 'push' && literalCwd) {
    objection = literalDefaultPush(words.slice(i), literalCwd);
  }
  return objection;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    refuse('This hook could not read what it was asked to rule on, so it refused.');
  }

  if (payload.tool_name !== 'Bash') stepAside();

  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') {
    refuse('This hook could not find the command to rule on, so it refused.');
  }

  let commands;
  try {
    commands = commandsIn(command);
  } catch (error) {
    refuse(`This hook could not read the command (${error.message}), so it refused.`);
  }

  for (const words of commands) {
    const objection = objectionTo(words, 0, commands.length === 1 ? payload.cwd : null);
    if (objection) {
      refuse(
        `AGENTS.md reserves this to the owner: ${objection}. Ask, rather than working around it.`,
      );
    }
  }

  stepAside();
}

try {
  main();
} catch (error) {
  refuse(`This hook failed (${error?.message ?? error}), so it refused rather than let the command run.`);
}
