import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from '@nestjs/common';
import { FilterValidationException } from '../errors/exceptions.js';

@Catch(FilterValidationException)
export class FilterExceptionFilter implements ExceptionFilter {
  catch(exception: FilterValidationException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      message: 'Filter input validation failed.',
      errors: exception.errors,
    });
  }
}
