/**
 * Evaluator for the game's itemcost equation strings — the expressions in
 * `records/game/itemcostformulas*.dbr` that produce attribute requirements,
 * e.g. `(2.1*(itemLevel*6.55)^1.25-1.80*(itemLevel*5.84)^1.2785+...)*0.98+12`.
 *
 * The grammar the shipped equations use is tiny: numbers, identifiers,
 * `+ - * / ^` and parentheses, with `^` binding tightest and right-associative
 * (`2^3^2` = 512) and unary minus below it (`-2^2` = −4, matching the maths
 * convention the equations rely on via terms like `*-5`).
 */

export function evaluateFormula(expr: string, vars: Record<string, number>): number {
  let pos = 0;

  const peek = (): string => {
    while (pos < expr.length && expr[pos] === ' ') pos++;
    return expr[pos] ?? '';
  };

  const fail = (message: string): never => {
    throw new Error(`${message} at ${pos} in "${expr}"`);
  };

  // expr := term (('+'|'-') term)*
  const expression = (): number => {
    let value = term();
    for (;;) {
      const c = peek();
      if (c === '+') {
        pos++;
        value += term();
      } else if (c === '-') {
        pos++;
        value -= term();
      } else {
        return value;
      }
    }
  };

  // term := unary (('*'|'/') unary)*
  const term = (): number => {
    let value = unary();
    for (;;) {
      const c = peek();
      if (c === '*') {
        pos++;
        value *= unary();
      } else if (c === '/') {
        pos++;
        value /= unary();
      } else {
        return value;
      }
    }
  };

  // unary := '-'? power
  const unary = (): number => {
    if (peek() === '-') {
      pos++;
      return -power();
    }
    return power();
  };

  // power := atom ('^' unary)?   — right-associative
  const power = (): number => {
    const base = atom();
    if (peek() === '^') {
      pos++;
      return base ** unary();
    }
    return base;
  };

  const atom = (): number => {
    const c = peek();
    if (c === '(') {
      pos++;
      const value = expression();
      if (peek() !== ')') fail('expected ")"');
      pos++;
      return value;
    }
    if (c >= '0' && c <= '9' || c === '.') {
      const start = pos;
      while (/[\d.]/.test(expr[pos] ?? '')) pos++;
      const value = Number(expr.slice(start, pos));
      if (Number.isNaN(value)) fail('bad number');
      return value;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = pos;
      while (/\w/.test(expr[pos] ?? '')) pos++;
      const name = expr.slice(start, pos);
      const value = vars[name];
      if (value === undefined) return fail(`unknown variable "${name}"`);
      return value;
    }
    return fail(c === '' ? 'unexpected end' : `unexpected "${c}"`);
  };

  const value = expression();
  if (peek() !== '') fail(`trailing "${peek()}"`);
  return value;
}
