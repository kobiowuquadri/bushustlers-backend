import { validationResult, checkSchema, type Schema, type ValidationChain } from 'express-validator';
import { asyncHandler, messageHandler } from '../utils/index.js';
import { VALIDATION_ERROR } from '../constants/statusCode.js';

// Accepts a checkSchema() schema object or an array of validation chains
export const validate = (validations: Schema | ValidationChain[]) => {
    const chains = Array.isArray(validations) ? validations : checkSchema(validations);

    return asyncHandler(async (req, res, next) => {
        await Promise.all(chains.map((validation) => validation.run(req)));

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            // Only field and message: express-validator also includes the submitted value (e.g. passwords)
            const details = errors.array({ onlyFirstError: true }).map((error) => ({
                field: error.type === 'field' ? error.path : error.type,
                message: error.msg,
            }));
            return res.status(VALIDATION_ERROR).json(messageHandler('Validation failed', false, VALIDATION_ERROR, { errors: details }));
        }
        next();
    });
}
