// apps/api/src/services/calclane.ts
var CALCLANE_VERSION = "0.3.0";
var FUNCS = /* @__PURE__ */ new Set([
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "log",
  "ln",
  "sqrt",
  "cbrt",
  "abs",
  "floor",
  "ceil",
  "round",
  "exp",
  "fact",
  "factorial"
]);
function formatNumber(n, fe = false) {
  if (!Number.isFinite(n)) throw new Error("Overflow");
  if (Object.is(n, -0)) return "0";
  if (fe) {
    return n.toExponential(10).replace(/e\+/, "e").replace(/(\.\d*?)0+e/, "$1e");
  }
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-10)) {
    return n.toExponential(10).replace(/e\+/, "e").replace(/(\.\d*?)0+e/, "$1e");
  }
  let s = n.toPrecision(15);
  if (/e/i.test(s)) return s.replace(/e\+/, "e");
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
function toRadians(value, unit) {
  if (unit === "deg") return value * Math.PI / 180;
  if (unit === "grad") return value * Math.PI / 200;
  return value;
}
function fromRadians(value, unit) {
  if (unit === "deg") return value * 180 / Math.PI;
  if (unit === "grad") return value * 200 / Math.PI;
  return value;
}
function factorial(n) {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || n > 170) {
    throw new Error("Invalid factorial input");
  }
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
function applyUnary(name, x, angle) {
  switch (name) {
    case "sin":
      return Math.sin(toRadians(x, angle));
    case "cos":
      return Math.cos(toRadians(x, angle));
    case "tan": {
      const t = Math.tan(toRadians(x, angle));
      if (!Number.isFinite(t)) throw new Error("Invalid input");
      return t;
    }
    case "asin":
      if (x < -1 || x > 1) throw new Error("Invalid input");
      return fromRadians(Math.asin(x), angle);
    case "acos":
      if (x < -1 || x > 1) throw new Error("Invalid input");
      return fromRadians(Math.acos(x), angle);
    case "atan":
      return fromRadians(Math.atan(x), angle);
    case "log":
      if (x <= 0) throw new Error("Invalid input");
      return Math.log10(x);
    case "ln":
      if (x <= 0) throw new Error("Invalid input");
      return Math.log(x);
    case "sqrt":
      if (x < 0) throw new Error("Invalid input");
      return Math.sqrt(x);
    case "cbrt":
      return Math.cbrt(x);
    case "abs":
      return Math.abs(x);
    case "floor":
      return Math.floor(x);
    case "ceil":
      return Math.ceil(x);
    case "round":
      return Math.round(x);
    case "exp":
      return Math.exp(x);
    case "fact":
    case "factorial":
      return factorial(x);
    default:
      throw new Error(`Unknown function: ${name}`);
  }
}
function applyBinary(op, a, b) {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      if (b === 0) throw new Error("Cannot divide by zero");
      return a / b;
    case "%":
    case "mod":
      if (b === 0) throw new Error("Cannot divide by zero");
      return a % b;
    case "^": {
      const r = Math.pow(a, b);
      if (!Number.isFinite(r)) throw new Error("Overflow");
      return r;
    }
    default:
      throw new Error(`Unknown operator: ${op}`);
  }
}
function tokenize(input) {
  const s = input.replace(/\s+/g, "");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j < s.length && (s[j] === "e" || s[j] === "E")) {
        j++;
        if (j < s.length && (s[j] === "+" || s[j] === "-")) j++;
        while (j < s.length && /[0-9]/.test(s[j])) j++;
      }
      const raw = s.slice(i, j);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Invalid number: ${raw}`);
      tokens.push({ kind: "num", value: n });
      i = j;
      continue;
    }
    if (/[a-zA-Z_π]/.test(c) || c === "\u03C0") {
      if (c === "\u03C0") {
        tokens.push({ kind: "const", value: "pi" });
        i++;
        continue;
      }
      let j = i + 1;
      while (j < s.length && /[a-zA-Z_0-9]/.test(s[j])) j++;
      const name = s.slice(i, j).toLowerCase();
      if (name === "pi") tokens.push({ kind: "const", value: "pi" });
      else if (name === "e") tokens.push({ kind: "const", value: "e" });
      else if (FUNCS.has(name)) tokens.push({ kind: "fn", value: name });
      else if (name === "mod") tokens.push({ kind: "op", value: "mod" });
      else throw new Error(`Unknown identifier: ${name}`);
      i = j;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%" || c === "^" || c === "\xD7" || c === "\xF7") {
      if (c === "*" && s[i + 1] === "*") {
        tokens.push({ kind: "op", value: "^" });
        i += 2;
        continue;
      }
      tokens.push({ kind: "op", value: c === "\xD7" ? "*" : c === "\xF7" ? "/" : c });
      i++;
      continue;
    }
    if (c === "!") {
      tokens.push({ kind: "op", value: "!" });
      i++;
      continue;
    }
    throw new Error(`Unexpected character: ${c}`);
  }
  return tokens;
}
var Parser = class {
  constructor(tokens, mode, angle) {
    this.tokens = tokens;
    this.mode = mode;
    this.angle = angle;
  }
  tokens;
  mode;
  angle;
  i = 0;
  parse() {
    const v = this.parseExpr();
    if (this.i < this.tokens.length) throw new Error("Unexpected trailing tokens");
    return v;
  }
  peek() {
    return this.tokens[this.i];
  }
  take() {
    const t = this.tokens[this.i++];
    if (!t) throw new Error("Unexpected end of expression");
    return t;
  }
  parseExpr() {
    return this.mode === "standard" ? this.parseLeftToRight() : this.parseAdd();
  }
  parseLeftToRight() {
    let left = this.parseUnary();
    while (this.peek()?.kind === "op") {
      const op = this.peek().value;
      if (op === "!") break;
      this.take();
      const right = this.parseUnary();
      left = applyBinary(op === "mod" ? "mod" : op, left, right);
    }
    while (this.peek()?.kind === "op" && this.peek().value === "!") {
      this.take();
      left = factorial(left);
    }
    return left;
  }
  parseAdd() {
    let left = this.parseMul();
    while (this.peek()?.kind === "op") {
      const op = this.peek().value;
      if (op !== "+" && op !== "-") break;
      this.take();
      left = applyBinary(op, left, this.parseMul());
    }
    return left;
  }
  parseMul() {
    let left = this.parsePow();
    while (this.peek()?.kind === "op") {
      const op = this.peek().value;
      if (op !== "*" && op !== "/" && op !== "%" && op !== "mod") break;
      this.take();
      left = applyBinary(op, left, this.parsePow());
    }
    return left;
  }
  parsePow() {
    let left = this.parseUnary();
    if (this.peek()?.kind === "op" && this.peek().value === "^") {
      this.take();
      left = applyBinary("^", left, this.parsePow());
    }
    while (this.peek()?.kind === "op" && this.peek().value === "!") {
      this.take();
      left = factorial(left);
    }
    return left;
  }
  parseUnary() {
    const t = this.peek();
    if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
      this.take();
      const v = this.parseUnary();
      return t.value === "-" ? -v : v;
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.take();
    if (t.kind === "num") return t.value;
    if (t.kind === "const") return t.value === "pi" ? Math.PI : Math.E;
    if (t.kind === "fn") {
      if (this.peek()?.kind !== "lparen") throw new Error(`Expected ( after ${t.value}`);
      this.take();
      const arg = this.parseAdd();
      if (this.peek()?.kind !== "rparen") throw new Error("Expected )");
      this.take();
      return applyUnary(t.value, arg, this.angle);
    }
    if (t.kind === "lparen") {
      const v = this.mode === "standard" ? this.parseLeftToRight() : this.parseAdd();
      if (this.peek()?.kind !== "rparen") throw new Error("Expected )");
      this.take();
      return v;
    }
    throw new Error("Expected number, constant, function, or (");
  }
};
function evaluateExpression(expression, options = {}) {
  const mode = options.mode === "standard" ? "standard" : "scientific";
  const angle = options.angle === "rad" || options.angle === "grad" ? options.angle : "deg";
  const expr = String(expression ?? "").trim();
  if (!expr) {
    return {
      ok: false,
      expression: expr,
      result: NaN,
      display: "Invalid input",
      mode,
      angle,
      engine: "calclane",
      version: CALCLANE_VERSION,
      error: "expression is required"
    };
  }
  try {
    const tokens = tokenize(expr);
    const result = new Parser(tokens, mode, angle).parse();
    if (!Number.isFinite(result)) throw new Error("Overflow");
    return {
      ok: true,
      expression: expr,
      result,
      display: formatNumber(result, Boolean(options.fe)),
      mode,
      angle,
      engine: "calclane",
      version: CALCLANE_VERSION
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Evaluation failed";
    return {
      ok: false,
      expression: expr,
      result: NaN,
      display: message,
      mode,
      angle,
      engine: "calclane",
      version: CALCLANE_VERSION,
      error: message
    };
  }
}
function runDispatch(input) {
  let display = "0";
  let expression = "";
  let error;
  let acc = null;
  let pending = null;
  let overwriting = true;
  const mode = input.mode === "standard" ? "standard" : "scientific";
  const angle = input.angle === "rad" || input.angle === "grad" ? input.angle : "deg";
  const cmds = Array.isArray(input.commands) ? input.commands : [];
  if (!cmds.length) {
    return { ok: false, display, expression, error: "commands array is required", engine: "calclane", version: CALCLANE_VERSION };
  }
  const read = () => Number(display);
  const write = (n) => {
    display = formatNumber(n);
  };
  try {
    for (const cmd of cmds) {
      const type = String(cmd.type || "");
      if (type === "digit") {
        const d = String(cmd.value ?? "");
        if (overwriting) {
          display = d;
          overwriting = false;
        } else if (display === "0") display = d;
        else display += d;
      } else if (type === "dot") {
        if (overwriting) {
          display = "0.";
          overwriting = false;
        } else if (!display.includes(".")) display += ".";
      } else if (type === "binary") {
        const op = String(cmd.op || "+");
        const cur = read();
        if (pending != null && acc != null && !overwriting) {
          const r = evaluateExpression(`${acc}${pending === "\xD7" || pending === "*" ? "*" : pending === "\xF7" || pending === "/" ? "/" : pending}${cur}`, {
            mode: mode === "standard" ? "standard" : "scientific"
          });
          if (!r.ok) throw new Error(r.error || "Invalid");
          acc = r.result;
          write(acc);
        } else acc = cur;
        pending = op;
        expression = `${formatNumber(acc)} ${op}`;
        overwriting = true;
      } else if (type === "unary") {
        const op = String(cmd.op || "");
        const cur = read();
        const map = {
          "\u221A": `sqrt(${cur})`,
          sqrt: `sqrt(${cur})`,
          sin: `sin(${cur})`,
          cos: `cos(${cur})`,
          tan: `tan(${cur})`,
          log: `log(${cur})`,
          ln: `ln(${cur})`,
          abs: `abs(${cur})`,
          fact: `fact(${cur})`,
          "1/x": `(1/(${cur}))`,
          sqr: `((${cur})*(${cur}))`,
          "\xB1": `-(${cur})`
        };
        const expr = map[op] || `${op}(${cur})`;
        const r = evaluateExpression(expr, { mode: "scientific", angle });
        if (!r.ok) throw new Error(r.error || "Invalid");
        write(r.result);
        expression = expr;
        overwriting = true;
      } else if (type === "equals") {
        const cur = read();
        if (pending != null && acc != null) {
          const op = pending === "\xD7" ? "*" : pending === "\xF7" ? "/" : pending;
          const r = evaluateExpression(`${acc}${op}${cur}`, {
            mode: mode === "standard" ? "standard" : "scientific"
          });
          if (!r.ok) throw new Error(r.error || "Invalid");
          expression = `${formatNumber(acc)} ${pending} ${formatNumber(cur)} =`;
          write(r.result);
          acc = r.result;
          pending = null;
          overwriting = true;
        }
      } else if (type === "clear") {
        display = "0";
        expression = "";
        acc = null;
        pending = null;
        overwriting = true;
      } else if (type === "const") {
        const name = String(cmd.name || "");
        write(name === "e" ? Math.E : Math.PI);
        overwriting = true;
      } else if (type === "loadValue") {
        write(Number(cmd.value));
        expression = String(cmd.expression || "");
        overwriting = true;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Dispatch failed";
    display = error;
  }
  return {
    ok: !error,
    display,
    expression,
    error,
    engine: "calclane",
    version: CALCLANE_VERSION
  };
}
function getCalcLanePricing() {
  return {
    product: "calclane",
    currency: "credits",
    credits: {
      "calclane.evaluate": 1,
      "calclane.dispatch": 1
    },
    version: CALCLANE_VERSION
  };
}
function getCalcLaneCapabilities() {
  return {
    product: "calclane",
    version: CALCLANE_VERSION,
    modes: ["standard", "scientific"],
    angles: ["deg", "rad", "grad"],
    features: [
      "expression-evaluate",
      "command-dispatch",
      "trig",
      "logs",
      "powers",
      "roots",
      "factorial"
    ],
    endpoints: [
      "GET /v1/calclane/health",
      "GET /v1/calclane/pricing",
      "GET /v1/calclane/capabilities",
      "POST /v1/calclane/evaluate",
      "POST /v1/calclane/dispatch"
    ]
  };
}
export {
  CALCLANE_VERSION,
  evaluateExpression,
  getCalcLaneCapabilities,
  getCalcLanePricing,
  runDispatch
};
