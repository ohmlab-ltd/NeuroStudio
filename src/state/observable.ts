import { useSyncExternalStore } from "react";

/** A value with listeners and a React binding. */
export class Observable<T> {
  private listeners = new Set<() => void>();
  private value: T;

  constructor(initial: T) {
    this.value = initial;
    this.get = this.get.bind(this);
    this.subscribe = this.subscribe.bind(this);
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    this.notify();
  }

  /** Always notifies, for mutable holders. */
  update(producer: (current: T) => T): void {
    this.value = producer(this.value);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function useObservable<T>(observable: Observable<T>): T {
  return useSyncExternalStore(observable.subscribe, observable.get, observable.get);
}

/** Re-renders only when the selected slice changes. */
export function useObservableSelector<T, S>(observable: Observable<T>, select: (value: T) => S): S {
  return useSyncExternalStore(
    observable.subscribe,
    () => select(observable.get()),
    () => select(observable.get()),
  );
}
