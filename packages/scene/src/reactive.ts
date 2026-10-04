// Reactive system — Proxy-based dependency tracking.
// Proxy reactivity (reactive/effect). Expression evaluation lives in expr.ts
// in v0.6; tml:* attribute values are bare expressions, see binding.ts.

type Subscriber = () => void;

let activeEffect: Subscriber | null = null;
const targetMap = new WeakMap<object, Map<string | symbol, Set<Subscriber>>>();

function track(target: object, key: string | symbol): void {
  if (!activeEffect) return;

  let depsMap = targetMap.get(target);
  if (!depsMap) {
    depsMap = new Map();
    targetMap.set(target, depsMap);
  }

  let deps = depsMap.get(key);
  if (!deps) {
    deps = new Set();
    depsMap.set(key, deps);
  }

  deps.add(activeEffect);
}

function trigger(target: object, key: string | symbol): void {
  const depsMap = targetMap.get(target);
  if (!depsMap) return;

  const deps = depsMap.get(key);
  if (deps) {
    // Copy before iterating: effects may re-subscribe while running.
    [...deps].forEach((sub) => sub());
  }
}

const proxyCache = new WeakMap<object, object>();

export function reactive<T extends object>(obj: T): T {
  const existing = proxyCache.get(obj);
  if (existing) return existing as T;

  const proxy = new Proxy(obj, {
    get(target, key, receiver) {
      track(target, key);
      const result = Reflect.get(target, key, receiver);
      // Deep reactivity: wrap nested objects lazily.
      if (result && typeof result === 'object') {
        return reactive(result as object);
      }
      return result;
    },
    set(target, key, value, receiver) {
      const oldValue = Reflect.get(target, key, receiver);
      const result = Reflect.set(target, key, value, receiver);
      if (oldValue !== value) {
        trigger(target, key);
      }
      return result;
    },
  });

  proxyCache.set(obj, proxy);
  return proxy as T;
}

export function effect(fn: Subscriber): Subscriber {
  const effectFn: Subscriber = () => {
    const prev = activeEffect;
    activeEffect = effectFn;
    try {
      fn();
    } finally {
      activeEffect = prev;
    }
  };
  effectFn();
  return effectFn;
}

// Expressions are evaluated by the sandboxed interpreter in expr.ts (CSP-safe, no code
// generation); re-exported here so the v0.5 import path keeps working.
export { evalExpression } from './expr.js';
