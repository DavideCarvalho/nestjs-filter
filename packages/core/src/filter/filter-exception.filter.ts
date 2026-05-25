import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from '@nestjs/common';
import { FilterValidationException } from '../errors/exceptions.js';

@Catch(FilterValidationException)
export class FilterExceptionFilter implements ExceptionFilter {
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
      message: 'Filter input validation failed.',
      errors: sanitizedErrors,
    });
  }
}
