/**
 * @module dts-emitter
 *
 * TypeScript declaration file (`.d.ts`) emitter.
 *
 * Generates `.d.ts` content from a type-checked AST. Only exported declarations
 * are emitted. The emitter converts internal {@link Type} representations to
 * TypeScript syntax strings via {@link typeToTsString}.
 *
 * ADT type declarations emit:
 * 1. An interface per variant (with `readonly _tag` discriminant).
 * 2. A type alias that is the union of all variant interfaces.
 * 3. Constructor declarations (factory functions or const singletons).
 */

import type {
  Program, LetDeclaration, TypeDeclaration,
  ExportDeclaration, ExtensionFunctionDeclaration,
  InterfaceDeclaration,
  Declaration, Statement, TypeNode,
} from '../parser/ast.js';
import type {
  Type, FunctionType, ADTType, RecordType,
  NullableType, ArrayType, TupleType, UnionType,
  PromiseType, GenericType, PrimitiveType,
  SetType, MapType,
} from '../checker/types.js';
import { resolveType } from '../checker/types.js';
import { rewriteImportPath } from '../utils/constants.js';

// ── Type to TypeScript String ──────────────────────────────

/**
 * Convert an internal {@link Type} to its TypeScript syntax string for `.d.ts` output.
 *
 * Handles all type kinds including primitives, nullable (`T | null`), functions,
 * records (`{ readonly field: Type }`), arrays, tuples, unions, ADTs, generics,
 * and promises. Unresolved type variables and error types map to `any`.
 *
 * @param type - The internal type to convert.
 * @returns A TypeScript type syntax string.
 */
function typeToTsString(type: Type): string {
  const resolved = resolveType(type);

  switch (resolved.kind) {
    case 'primitive':
      return (resolved as PrimitiveType).name;
    case 'any':
      return 'any';
    case 'null':
      return 'null';
    case 'error':
      return 'any';
    case 'nullable':
      return `${typeToTsString((resolved as NullableType).inner)} | null`;
    case 'function':
      return functionTypeToString(resolved as FunctionType);
    case 'record':
      return recordTypeToString(resolved as RecordType);
    case 'lazy-record':
      // Lazy records should not appear in .d.ts output (they come from TS imports,
      // not EffectScript source). Fall back to 'any' if one is encountered.
      return 'any';
    case 'array':
      return `Array<${typeToTsString((resolved as ArrayType).element)}>`;
    case 'tuple': {
      const elements = (resolved as TupleType).elements.map(typeToTsString).join(', ');
      return `[${elements}]`;
    }
    case 'union':
      return (resolved as UnionType).members.map(typeToTsString).join(' | ');
    case 'adt': {
      const adt = resolved as ADTType;
      if (adt.typeArgs.length === 0) return adt.name;
      return `${adt.name}<${adt.typeArgs.map(typeToTsString).join(', ')}>`;
    }
    case 'generic':
      return (resolved as GenericType).name;
    case 'typevar':
      return 'any';
    case 'promise':
      return `Promise<${typeToTsString((resolved as PromiseType).inner)}>`;
    case 'set':
      return `Set<${typeToTsString((resolved as SetType).element)}>`;
    case 'map': {
      const mt = resolved as MapType;
      return `Map<${typeToTsString(mt.key)}, ${typeToTsString(mt.value)}>`;
    }
    case 'literal': {
      const lt = resolved as import('../checker/types.js').LiteralType;
      if (lt.base === 'string') {
        const escaped = String(lt.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `"${escaped}"`;
      }
      return String(lt.value);
    }
    case 'interface': {
      const iface = resolved as import('../checker/types.js').InterfaceType;
      if (iface.typeArgs.length === 0) return iface.name;
      const args = iface.typeArgs.map(a => typeToTsString(a)).join(', ');
      return `${iface.name}<${args}>`;
    }
    case 'index-signature': {
      const idxSig = resolved as import('../checker/types.js').IndexSignatureType;
      const indexPart = `[key: ${idxSig.keyType}]: ${typeToTsString(idxSig.valueType)}`;
      if (idxSig.fields.size === 0) {
        return `{ ${indexPart} }`;
      }
      const fieldParts = Array.from(idxSig.fields.entries())
        .map(([name, type]) => `readonly ${name}: ${typeToTsString(type)}`);
      return `{ ${fieldParts.join('; ')}; ${indexPart} }`;
    }
    case 'platform':
      return typeToTsString(resolved.inner);
  }
}

/** Convert a function type to TypeScript syntax (e.g. `<T extends Foo>(x: T) => string`). */
function functionTypeToString(ft: FunctionType): string {
  const typeParams = ft.typeParams && ft.typeParams.length > 0
    ? `<${ft.typeParams.map(tp => {
        const constraint = tp.constraint
          ? ` extends ${typeToTsString(tp.constraint)}`
          : '';
        return `${tp.name}${constraint}`;
      }).join(', ')}>`
    : '';
  const paramParts = ft.params.map(p => `${p.name}: ${typeToTsString(p.type)}`);
  if (ft.rest) {
    paramParts.push(`...${ft.rest.name}: ${typeToTsString(ft.rest.elementType)}[]`);
  }
  return `${typeParams}(${paramParts.join(', ')}) => ${typeToTsString(ft.returnType)}`;
}

/** Convert a record type to TypeScript syntax (e.g. `{ readonly name: string; score: number }`). */
function recordTypeToString(rt: RecordType): string {
  const fields = Array.from(rt.fields.entries())
    .map(([name, type]) => {
      const prefix = rt.mutableFields?.has(name) ? '' : 'readonly ';
      return `${prefix}${name}: ${typeToTsString(type)}`;
    })
    .join('; ');
  return `{ ${fields} }`;
}

// ── TypeNode to TypeScript String ───────────────────────────

/**
 * Convert an AST {@link TypeNode} to its TypeScript syntax string.
 * Used for interface property/method type annotations in .d.ts output.
 */
function typeNodeToTsString(node: TypeNode): string {
  switch (node.kind) {
    case 'NamedType': {
      const name = node.name.name;
      if (node.typeArgs && node.typeArgs.length > 0) {
        return `${name}<${node.typeArgs.map(typeNodeToTsString).join(', ')}>`;
      }
      return name;
    }
    case 'FunctionType': {
      const params = node.params.map((p, i) => `arg${i}: ${typeNodeToTsString(p)}`).join(', ');
      return `(${params}) => ${typeNodeToTsString(node.returnType)}`;
    }
    case 'RecordType': {
      const fields = node.fields.map(f => {
        const opt = f.optional ? '?' : '';
        return `readonly ${f.name.name}${opt}: ${typeNodeToTsString(f.type)}`;
      }).join('; ');
      return `{ ${fields} }`;
    }
    case 'NullableType':
      return `${typeNodeToTsString(node.inner)} | null`;
    case 'UnionType':
      return node.members.map(typeNodeToTsString).join(' | ');
    case 'TupleType': {
      const elements = node.elements.map(typeNodeToTsString).join(', ');
      return `[${elements}]`;
    }
    case 'LiteralTypeNode': {
      if (node.literal.kind === 'StringLiteral') {
        const escaped = node.literal.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `"${escaped}"`;
      }
      return String(node.literal.value);
    }
    case 'IntersectionType':
      return node.members.map(typeNodeToTsString).join(' & ');
  }
}

// ── Main Entry Point ───────────────────────────────────────

/**
 * Emit TypeScript declaration (`.d.ts`) content from a typed AST.
 *
 * Only exported declarations are emitted. Each top-level item is processed
 * in order, and the resulting lines are joined with newlines.
 *
 * @param ast - The type-checked AST.
 * @returns The `.d.ts` file content as a string.
 */
export function emitDTS(ast: Program): string {
  const lines: string[] = [];

  for (const item of ast.body) {
    emitTopLevel(lines, item);
  }

  return lines.join('\n');
}

// ── Top-Level ──────────────────────────────────────────────

/** Dispatch a top-level item to the appropriate DTS emitter (only exported items are emitted). */
function emitTopLevel(lines: string[], node: Declaration | Statement): void {
  switch (node.kind) {
    case 'LetDeclaration':
      if (node.exported) {
        emitLetDTS(lines, node);
      }
      break;
    case 'TypeDeclaration':
      if (node.exported) {
        emitTypeDTS(lines, node);
      }
      break;
    case 'ExtensionFunctionDeclaration':
      if (node.exported) {
        emitExtensionDTS(lines, node);
      }
      break;
    case 'InterfaceDeclaration':
      if (node.exported) {
        emitInterfaceDTS(lines, node);
      }
      break;
    case 'ExportDeclaration':
      emitExportDTS(lines, node);
      break;
    default:
      break;
  }
}

// ── Let Declaration ────────────────────────────────────────

/** Emit a `let` declaration as `export declare const/let name: Type;`. */
function emitLetDTS(lines: string[], node: LetDeclaration): void {
  const keyword = node.mutable ? 'let' : 'const';
  const type = node.resolvedType;
  if (type === undefined) return;

  const resolved = resolveType(type);

  // Tuple destructuring: emit separate declarations for each binding
  if (node.tuplePattern !== undefined && resolved.kind === 'tuple') {
    const tupleType = resolved as TupleType;
    for (let i = 0; i < node.tuplePattern.elements.length; i++) {
      const el = node.tuplePattern.elements[i];
      const elType = i < tupleType.elements.length ? tupleType.elements[i] : undefined;
      if (el.kind === 'Identifier') {
        lines.push(`export declare ${keyword} ${el.name}: ${elType ? typeToTsString(resolveType(elType)) : 'unknown'};`);
      } else if (el.kind === 'BindingPattern') {
        lines.push(`export declare ${keyword} ${el.name.name}: ${elType ? typeToTsString(resolveType(elType)) : 'unknown'};`);
      }
      // WildcardPattern elements are not exported
    }
    return;
  }

  if (resolved.kind === 'function') {
    const ft = resolved as FunctionType;
    const typeStr = functionTypeToString(ft);
    lines.push(`export declare ${keyword} ${node.name.name}: ${typeStr};`);
  } else {
    lines.push(`export declare ${keyword} ${node.name.name}: ${typeToTsString(resolved)};`);
  }
}

// ── Extension Function Declaration ────────────────────────

/** Emit an extension function as `export declare const Type_method: (__this: ReceiverType, ...params) => ReturnType;`. */
function emitExtensionDTS(lines: string[], node: ExtensionFunctionDeclaration): void {
  const type = node.resolvedType;
  if (type === undefined) return;

  const resolved = resolveType(type);
  if (resolved.kind !== 'function') return;

  const ft = resolved as FunctionType;
  const receiverTypeName = getReceiverTypeName(node.receiverType);
  const emitName = `${receiverTypeName}_${node.name.name}`;

  const typeParams = ft.typeParams && ft.typeParams.length > 0
    ? `<${ft.typeParams.map(tp => {
        const constraint = tp.constraint
          ? ` extends ${typeToTsString(tp.constraint)}`
          : '';
        return `${tp.name}${constraint}`;
      }).join(', ')}>`
    : '';

  const receiverTypeStr = node.resolvedReceiverType !== undefined
    ? typeToTsString(node.resolvedReceiverType)
    : receiverTypeName;

  const params = [`__this: ${receiverTypeStr}`, ...ft.params.map(p => `${p.name}: ${typeToTsString(p.type)}`)];
  lines.push(`export declare const ${emitName}: ${typeParams}(${params.join(', ')}) => ${typeToTsString(ft.returnType)};`);
}

/** Extract the receiver type name from a TypeNode. */
function getReceiverTypeName(typeNode: unknown): string {
  const node = typeNode as { kind: string; name?: { name: string } };
  if (node.kind === 'NamedType' && node.name) {
    return node.name.name;
  }
  return 'unknown';
}

// ── Interface Declaration ───────────────────────────────────

/** Emit an EffectScript `interface` declaration as a TS `export interface`. */
function emitInterfaceDTS(lines: string[], node: InterfaceDeclaration): void {
  const typeParamsStr = emitTypeParamsStr(node.typeParams);
  const extendsStr = node.extends
    ? ` extends ${node.extends.map(t => typeNodeToTsString(t)).join(', ')}`
    : '';
  lines.push(`export interface ${node.name.name}${typeParamsStr}${extendsStr} {`);
  for (const prop of node.properties) {
    const readonlyPrefix = prop.mutable ? '' : 'readonly ';
    lines.push(`  ${readonlyPrefix}${prop.name.name}: ${typeNodeToTsString(prop.typeAnnotation)};`);
  }
  for (const method of node.methods) {
    const methodTypeParams = emitTypeParamsStr(method.typeParams);
    const params = method.params.map(p => `${p.name.name}: ${p.type ? typeNodeToTsString(p.type) : 'any'}`).join(', ');
    const returnType = method.returnType ? typeNodeToTsString(method.returnType) : 'void';
    lines.push(`  ${method.name.name}${methodTypeParams}(${params}): ${returnType};`);
  }
  lines.push('}');
}

/** Format type parameters for DTS output (e.g. `<T, U extends Foo>`). */
function emitTypeParamsStr(typeParams?: readonly import('../parser/ast.js').TypeParameter[]): string {
  if (!typeParams || typeParams.length === 0) return '';
  return `<${typeParams.map(tp => {
    const constraint = tp.constraint ? ` extends ${typeNodeToTsString(tp.constraint)}` : '';
    return `${tp.name.name}${constraint}`;
  }).join(', ')}>`;
}

// ── Type Declaration (ADT) ─────────────────────────────────

/**
 * Emit a type declaration as DTS.
 *
 * Named record aliases emit `export type Name = { ... };`.
 * ADTs emit variant interfaces, a union type alias, and constructor declarations.
 */
function emitTypeDTS(lines: string[], node: TypeDeclaration): void {
  // Named record type alias: emit as `export type Name = { ... };`
  // Also handles general type aliases (literal unions, etc.)
  if (node.recordType !== undefined || node.typeAlias !== undefined) {
    const resolved = (node as unknown as { resolvedType?: Type }).resolvedType;
    if (resolved !== undefined) {
      lines.push(`export type ${node.name.name} = ${typeToTsString(resolved)};`);
    }
    return;
  }

  const typeParamNames = node.typeParams?.map(tp => tp.name.name) ?? [];

  // Build a map from param name to its constrained DTS string (e.g., "T extends { id: string }")
  const adtType = (node as unknown as { resolvedType?: Type }).resolvedType;
  const resolvedAdt = adtType ? resolveType(adtType) : undefined;
  const constraintMap = new Map<string, string>();
  if (resolvedAdt && resolvedAdt.kind === 'adt' && resolvedAdt.typeParams) {
    for (let i = 0; i < resolvedAdt.typeParams.length; i++) {
      const tp = resolvedAdt.typeParams[i];
      if (tp.constraint) {
        constraintMap.set(tp.name, ` extends ${typeToTsString(tp.constraint)}`);
      }
    }
  }
  const formatTypeParam = (name: string): string => `${name}${constraintMap.get(name) ?? ''}`;

  for (const v of node.variants) {
    emitVariantInterface(lines, v, typeParamNames, formatTypeParam);
  }

  // Type alias: union of all variants
  const variantRefs = node.variants.map(v => {
    const vTypeParams = getVariantTypeParams(v, typeParamNames);
    return vTypeParams.length > 0 ? `${v.name.name}<${vTypeParams.join(', ')}>` : v.name.name;
  });

  const typeParamStr = typeParamNames.length > 0
    ? `<${typeParamNames.map(formatTypeParam).join(', ')}>`
    : '';
  lines.push(`export type ${node.name.name}${typeParamStr} = ${variantRefs.join(' | ')};`);

  // Constructor declarations
  for (const v of node.variants) {
    emitVariantConstructorDTS(lines, v, typeParamNames, formatTypeParam);
  }
}

/** Emit an `export interface` for a single ADT variant with `_tag` discriminant and fields. */
function emitVariantInterface(
  lines: string[],
  v: import('../parser/ast.js').VariantDeclaration,
  typeParamNames: string[],
  formatTypeParam: (name: string) => string = (n) => n,
): void {
  const vTypeParams = getVariantTypeParams(v, typeParamNames);
  const typeParamStr = vTypeParams.length > 0 ? `<${vTypeParams.map(formatTypeParam).join(', ')}>` : '';

  lines.push(`export interface ${v.name.name}${typeParamStr} {`);
  lines.push(`  readonly _tag: "${v.name.name}";`);

  for (const field of v.fields) {
    // Get the type from the resolved type on the variant if available
    const fieldType = getVariantFieldType(v, field.name.name);
    lines.push(`  readonly ${field.name.name}: ${fieldType};`);
  }

  lines.push('}');
}

/**
 * Get the TypeScript type string for a variant field.
 *
 * Prefers the resolved type from the variant's constructor function.
 * Falls back to the type annotation's name from the AST.
 */
function getVariantFieldType(v: import('../parser/ast.js').VariantDeclaration, fieldName: string): string {
  // If the variant has a resolvedType (FunctionType), extract field types from its params
  if (v.resolvedType !== undefined) {
    const resolved = resolveType(v.resolvedType);
    if (resolved.kind === 'function') {
      const ft = resolved as FunctionType;
      const param = ft.params.find(p => p.name === fieldName);
      if (param !== undefined) {
        return typeToTsString(param.type);
      }
    }
  }

  // Fallback: use the type annotation's name (TypeNode → string approximation)
  for (const field of v.fields) {
    if (field.name.name === fieldName) {
      if (field.type.kind === 'NamedType') {
        return field.type.name.name;
      }
    }
  }
  return 'unknown';
}

/**
 * Determine which of the ADT's type parameters are actually used by a variant.
 *
 * Only includes type parameters that appear in the variant's field types.
 * This ensures variant interfaces only declare the type parameters they need.
 */
function getVariantTypeParams(v: import('../parser/ast.js').VariantDeclaration, allTypeParams: string[]): string[] {
  if (allTypeParams.length === 0) return [];

  // Check which type params this variant actually uses
  const usedParams: string[] = [];

  if (v.resolvedType !== undefined) {
    const resolved = resolveType(v.resolvedType);
    if (resolved.kind === 'function') {
      const ft = resolved as FunctionType;
      for (const paramName of allTypeParams) {
        if (usesGeneric(ft, paramName)) {
          usedParams.push(paramName);
        }
      }
      return usedParams;
    }
  }

  // If no resolved type, check field type annotations for generic names
  for (const field of v.fields) {
    if (field.type.kind === 'NamedType') {
      const name = field.type.name.name;
      if (allTypeParams.includes(name) && !usedParams.includes(name)) {
        usedParams.push(name);
      }
    }
  }

  return usedParams;
}

/** Check if a function type's *parameters* (not return type) use a given generic name.
 * For variant interfaces, we only want generics that appear in the fields (params). */
function usesGeneric(ft: FunctionType, name: string): boolean {
  for (const param of ft.params) {
    if (typeUsesGeneric(param.type, name)) return true;
  }
  return false;
}

/** Recursively check if a type references a generic type parameter by name. */
function typeUsesGeneric(type: Type, name: string): boolean {
  const resolved = resolveType(type);
  switch (resolved.kind) {
    case 'generic':
      return (resolved as GenericType).name === name;
    case 'nullable':
      return typeUsesGeneric((resolved as NullableType).inner, name);
    case 'array':
      return typeUsesGeneric((resolved as ArrayType).element, name);
    case 'tuple':
      return (resolved as TupleType).elements.some(e => typeUsesGeneric(e, name));
    case 'union':
      return (resolved as UnionType).members.some(m => typeUsesGeneric(m, name));
    case 'function': {
      const ft = resolved as FunctionType;
      return ft.params.some(p => typeUsesGeneric(p.type, name)) || typeUsesGeneric(ft.returnType, name);
    }
    case 'record':
      return Array.from((resolved as RecordType).fields.values()).some(t => typeUsesGeneric(t, name));
    case 'adt':
      return (resolved as ADTType).typeArgs.some(a => typeUsesGeneric(a, name));
    case 'promise':
      return typeUsesGeneric((resolved as PromiseType).inner, name);
    case 'set':
      return typeUsesGeneric((resolved as SetType).element, name);
    case 'map': {
      const mt = resolved as MapType;
      return typeUsesGeneric(mt.key, name) || typeUsesGeneric(mt.value, name);
    }
    case 'platform':
      return typeUsesGeneric(resolved.inner, name);
    default:
      return false;
  }
}

/**
 * Emit a DTS constructor declaration for an ADT variant.
 *
 * Fieldless variants emit `export declare const Name: Name;`.
 * Variants with fields emit `export declare const Name: <T>(field: T) => Name<T>;`.
 */
function emitVariantConstructorDTS(
  lines: string[],
  v: import('../parser/ast.js').VariantDeclaration,
  typeParamNames: string[],
  formatTypeParam: (name: string) => string = (n) => n,
): void {
  const vTypeParams = getVariantTypeParams(v, typeParamNames);

  if (v.fields.length === 0) {
    // Fieldless variant: const singleton
    lines.push(`export declare const ${v.name.name}: ${v.name.name};`);
  } else {
    // Variant with fields: factory function
    const typeParamStr = vTypeParams.length > 0 ? `<${vTypeParams.map(formatTypeParam).join(', ')}>` : '';
    const params: string[] = [];
    const returnTypeParams = vTypeParams.length > 0 ? `<${vTypeParams.join(', ')}>` : '';

    for (const field of v.fields) {
      const fieldType = getVariantFieldType(v, field.name.name);
      params.push(`${field.name.name}: ${fieldType}`);
    }

    lines.push(`export declare const ${v.name.name}: ${typeParamStr}(${params.join(', ')}) => ${v.name.name}${returnTypeParams};`);
  }
}

// ── Export Declaration ─────────────────────────────────────

/** Emit an export declaration in DTS format (declaration exports, named re-exports). */
function emitExportDTS(lines: string[], node: ExportDeclaration): void {
  if (node.declaration !== undefined) {
    if (node.declaration.kind === 'LetDeclaration' && node.declaration.exported) {
      emitLetDTS(lines, node.declaration);
    } else if (node.declaration.kind === 'TypeDeclaration' && node.declaration.exported) {
      emitTypeDTS(lines, node.declaration);
    } else if (node.declaration.kind === 'ExtensionFunctionDeclaration' && node.declaration.exported) {
      emitExtensionDTS(lines, node.declaration as ExtensionFunctionDeclaration);
    } else if (node.declaration.kind === 'InterfaceDeclaration' && node.declaration.exported) {
      emitInterfaceDTS(lines, node.declaration as InterfaceDeclaration);
    }
    return;
  }

  if (node.specifiers !== undefined) {
    const specs = node.specifiers.map(s =>
      s.exported !== undefined ? `${s.local.name} as ${s.exported.name}` : s.local.name
    ).join(', ');
    if (node.source !== undefined) {
      const source = rewriteImportPath(node.source.value);
      lines.push(`export { ${specs} } from "${source}";`);
    } else {
      lines.push(`export { ${specs} };`);
    }
  }
}
