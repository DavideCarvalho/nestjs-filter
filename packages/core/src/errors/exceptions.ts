export abstract class FilterException extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class FilterNotRegisteredException extends FilterException {
  constructor(public readonly filterName: string) {
    super(`Filter ${filterName} not registered. Add it to FilterModule.forFeature([...]).`);
  }
}

export class FilterMissingEntityException extends FilterException {
  constructor(public readonly filterName: string) {
    super(`Filter ${filterName} is missing @Filterable({ entity }).`);
  }
}

export class FilterStateUnavailableException extends FilterException {
  constructor() {
    super('Filter state ($query, $input, $context) is only available inside FilterRunner.apply().');
  }
}

/** A `@TenantScoped` filter ran with nothing to scope it by. It fails rather than return every tenant. */
export class TenantScopeUnavailableException extends FilterException {
  constructor(
    public readonly filterName: string,
    public readonly reason: 'no-tenant' | 'no-adapter-support',
  ) {
    super(
      reason === 'no-tenant'
        ? `@TenantScoped filter ${filterName} ran with no tenant in context. Bind @dudousxd/nestjs-context, or pass { optional: true } if this filter may run without a tenant.`
        : `@TenantScoped filter ${filterName} needs an adapter that implements applyAutoField.`,
    );
  }
}

export class UnknownFilterKeyException extends FilterException {
  constructor(public readonly key: string) {
    super(`Unknown filter key "${key}". No method or @FilterFor matches.`);
  }
}

export class FilterValidationException extends FilterException {
  constructor(public readonly errors: unknown[]) {
    super('Filter input validation failed.');
  }
}

export class FilterMissingAdapterException extends FilterException {
  constructor() {
    super(
      'No FilterAdapter registered. Import an adapter module (e.g. MikroOrmFilterModule.forRoot()).',
    );
  }
}

export class FilterMethodException extends FilterException {
  constructor(
    public readonly key: string,
    public readonly value: unknown,
    public override readonly cause: unknown,
  ) {
    super(
      `Filter method for key "${key}" threw: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
