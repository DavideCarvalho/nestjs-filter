import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common';
import { FilterValidationException } from '../errors/exceptions.js';
import { type FilterTranslator, I18N_SERVICE, filterMessage } from '../i18n/filter-i18n.js';

/**
 * Turns a {@link FilterValidationException} into a 400. The `message` is
 * `filter.validationFailed` from `@nestjs/i18n` when the app registers it (and
 * its catalogs have the key), in English otherwise. Nest injects the
 * `I18nService` when the filter is registered as a class (`APP_FILTER`,
 * `@UseFilters(FilterExceptionFilter)`); an instance takes it as an argument:
 * `new FilterExceptionFilter(app.get(I18nService))`.
 */
@Catch(FilterValidationException)
export class FilterExceptionFilter implements ExceptionFilter {
  constructor(@Optional() @Inject(I18N_SERVICE) private readonly i18n?: FilterTranslator) {}

  catch(exception: FilterValidationException, host: ArgumentsHost) {
    if (host.getType() !== 'http') {
      throw exception; // re-throw for non-HTTP contexts (e.g. WebSocket, RPC)
    }
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const sanitizedErrors = (
      exception.errors as Array<{
        property?: unknown;
        constraints?: unknown;
        children?: unknown[];
      }>
    ).map((err) => ({
      property: err.property,
      constraints: err.constraints,
      ...(err.children?.length ? { children: err.children } : {}),
    }));
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      message: filterMessage(this.i18n, 'validationFailed'),
      errors: sanitizedErrors,
    });
  }
}
