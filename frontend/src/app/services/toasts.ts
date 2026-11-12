import { Service, signal } from '@angular/core';

export interface Toast {
  readonly id: number;
  readonly kind: 'error' | 'success';
  readonly message: string;
  /** The backend's X-Request-Id - users quote it, support finds the request in Loki/Tempo. */
  readonly requestId?: string;
}

/** Short messages for the toast outlet (components/shared/toast-outlet). */
@Service()
export class Toasts {
  static readonly errorLifetimeMs = 15_000;
  static readonly successLifetimeMs = 4_000;

  private nextId = 1;
  private readonly items = signal<readonly Toast[]>([]);
  readonly toasts = this.items.asReadonly();

  error(message: string, requestId?: string): void {
    this.push({ kind: 'error', message, requestId }, Toasts.errorLifetimeMs);
  }

  success(message: string): void {
    this.push({ kind: 'success', message }, Toasts.successLifetimeMs);
  }

  dismiss(id: number): void {
    this.items.update((all) => all.filter((toast) => toast.id !== id));
  }

  private push(toast: Omit<Toast, 'id'>, lifetimeMs: number): void {
    const id = this.nextId++;
    this.items.update((all) => [...all, { ...toast, id }]);
    setTimeout(() => this.dismiss(id), lifetimeMs);
  }
}
