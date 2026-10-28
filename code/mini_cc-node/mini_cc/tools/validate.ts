/**
 * 一个够用的 JSON Schema 子集校验器（type / required / properties / enum / items / additionalProperties /
 * minItems / maxItems）。（第 3 章；第 10 章用到 minItems / maxItems）
 *
 * 为什么不直接信任模型给的参数？开了 eager_input_streaming 后服务端不再校验，
 * SDK 的宽容解析器还可能给出被截断的对象。执行前自己查一遍，错了就把错误当工具结果还给模型。
 */

/** 值的 JSON 类型名（报错里用；Python 版报的是 Python 类型名 str / int / dict）。 */
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

export function validate(value: any, schema: Record<string, any>, path = "input"): string[] {
  const errors: string[] = [];
  const t: string | undefined = schema.type;
  if (t && !CHECKS[t](value)) return [`${path} should be ${t}, got ${typeName(value)}`];
  if ("enum" in schema && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (t === "object") {
    const props: Record<string, any> = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`The required parameter \`${key}\` is missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`An unexpected parameter \`${key}\` was provided`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`));
    }
  }
  if (t === "array") {
    if ("items" in schema) value.forEach((item: any, i: number) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    if ("minItems" in schema && value.length < schema.minItems) errors.push(`${path} must have at least ${schema.minItems} items`);
    if ("maxItems" in schema && value.length > schema.maxItems) errors.push(`${path} must have at most ${schema.maxItems} items`);
  }
  return errors;
}
