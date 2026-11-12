import { ComponentFixture } from '@angular/core/testing';

/** Small DOM helpers for plain TestBed tests - query by what the user sees. */
export function textOf(fixture: ComponentFixture<unknown>): string {
  return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

export function all<T extends Element = HTMLElement>(
  fixture: ComponentFixture<unknown>,
  selector: string,
): T[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<T>(selector));
}

export function buttonByText(fixture: ComponentFixture<unknown>, text: string): HTMLButtonElement {
  const button = all<HTMLButtonElement>(fixture, 'button').find(
    (b) => b.textContent?.replace(/\s+/g, ' ').trim() === text,
  );
  if (!button) {
    throw new Error(`No button "${text}" in: ${textOf(fixture)}`);
  }
  return button;
}

export function buttonByLabel(
  fixture: ComponentFixture<unknown>,
  label: string,
): HTMLButtonElement {
  const button = all<HTMLButtonElement>(fixture, `button[aria-label="${label}"]`)[0];
  if (!button) {
    throw new Error(`No button labelled "${label}" in: ${textOf(fixture)}`);
  }
  return button;
}

export function buttonTexts(fixture: ComponentFixture<unknown>): string[] {
  return all(fixture, 'button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

export function linkByText(fixture: ComponentFixture<unknown>, text: string): HTMLAnchorElement {
  const link = all<HTMLAnchorElement>(fixture, 'a').find(
    (a) => a.textContent?.replace(/\s+/g, ' ').trim() === text,
  );
  if (!link) {
    throw new Error(`No link "${text}" in: ${textOf(fixture)}`);
  }
  return link;
}

/** Types like a user: sets the value and fires `input`, which the form field listens to. */
export function typeInto(
  fixture: ComponentFixture<unknown>,
  selector: string,
  value: string,
): void {
  const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(selector);
  if (!input) {
    throw new Error(`No input matching "${selector}"`);
  }
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}
