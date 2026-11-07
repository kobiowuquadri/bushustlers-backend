## Quick Serve TypeScript – Starter Template

Production-ready Express + TypeScript starter with JWT auth, Sequelize (SQL), validation, file uploads, email (Nodemailer/Handlebars), and helpful utilities.

### Features
- **TypeScript + tsx**: Fast dev runtime with `tsx`, compiled builds via `tsc`
- **Express**: API server with helmet, CORS, morgan, cookie-parser, global error handling and a 404 handler
- **JWT Auth**: Register, login, refresh-token rotation, logout and profile endpoints
- **Security**: Rate-limited auth routes, hashed refresh tokens, typed access/refresh tokens, env validation at startup
- **Sequelize**: SQL ORM (MySQL by default); example `Auth` model wired
- **Validation**: `express-validator` schemas with a consistent error response
- **Email**: Nodemailer + Handlebars templates and Brevo (Sendinblue) REST support
- **Uploads**: Multer + Cloudinary (streamed uploads)
- **Utilities**: Async handler, `AppError`, pagination, secure OTP/token helpers, password and phone helpers

### Tech Stack
- Node.js (>= 20), TypeScript
- Express, express-validator, helmet, express-rate-limit
- Sequelize, mysql2
- jsonwebtoken, bcryptjs
- Nodemailer, nodemailer-express-handlebars, Brevo API (axios)
- Multer, Cloudinary

### Project Structure
```
src/
  config/
    config.ts                   # all env vars in one place, validated at startup
  constants/
    statusCode.ts               # HTTP status codes
  controllers/
    users/
      authController.ts         # thin controllers: call a service, send its result
  database/
    db.ts                       # Sequelize instance + connectToDB
  middlewares/
    auth.ts                     # `verify`: requires a Bearer access token, sets req.user
    errorHandler.ts             # `notFound` + global `errorHandler`
    rateLimiter.ts              # `authLimiter` for auth routes
  modules/
    notifications/
      email.ts                  # Nodemailer + Handlebars
      brevo.ts                  # Brevo REST email
    storage/
      cloudinary.ts             # Multer upload manager + Cloudinary upload helper
    views/                      # Handlebars email templates (copied to dist on build)
  routes/
    index.ts                    # mounts routers under /api/v1
    users/
      index.ts                  # auth routes
  schemas/
    users/
      authSchema.ts             # Sequelize model + init
  services/
    users/
      authService.ts            # auth business logic
  types/
    users/auth.ts               # DTOs for auth
    express.d.ts                # adds `req.user` to Express' Request type
    nodemailer-express-handlebars.d.ts # local type shim
  utils/                        # see "Utilities" below; import everything from utils/index.js
  validations/
    index.ts                    # `validate` middleware
    users/authValidations.ts    # auth validation schemas
  app.ts                        # Express app (middleware, routes, error handling)
  index.ts                      # starts the server after the DB connects; graceful shutdown
```

### Getting Started
1) Install dependencies
```bash
npm install
```

2) Configure environment: copy `.env.example` to `.env` and fill it in. `SECRET_KEY`, `DB_NAME` and `DB_USER` are required; the server refuses to start without them.

3) Database setup
- On startup the app connects to the database and runs `sequelize.sync()`, which creates missing tables but never alters existing ones. Use migrations for schema changes on an existing database.

4) Run in development
```bash
npm run dev
```

5) Build and start
```bash
npm run build
npm start
```

### API
All responses share one shape:
```json
{ "message": "Login successful", "success": true, "statusCode": 200, "data": { } }
```

| Method | Path                           | Auth   | Description                                     |
| ------ | ------------------------------ | ------ | ----------------------------------------------- |
| GET    | `/`                            | –      | Simple "server is running" message              |
| GET    | `/health`                      | –      | 200 when the database is reachable, 503 if not  |
| POST   | `/api/v1/users/register`       | –      | `{ email, password }` → tokens + user (201)     |
| POST   | `/api/v1/users/login`          | –      | `{ email, password }` → tokens + user           |
| POST   | `/api/v1/users/refresh-token`  | –      | `{ refreshToken }` → new token pair             |
| POST   | `/api/v1/users/logout`         | Bearer | Revokes the refresh token                       |
| GET    | `/api/v1/users/me`             | Bearer | Current user                                    |

Register, login and refresh share a rate limit of 20 requests per 15 minutes per IP.

### Auth Flow
- Access and refresh tokens carry a `type` claim, so a refresh token can't be used as an access token.
- Only a SHA-256 hash of the latest refresh token is stored. Each refresh rotates it, so an old refresh token stops working once it has been used.
- Logout clears the stored refresh token. The access token stays valid until it expires, so keep `ACCESS_TOKEN_EXPIRES_IN` short in production.
- One refresh token per user: logging in on a new device signs the previous device out at its next refresh.

### Validation
Pass a schema to `validate` in a route:
```ts
userRouter.post('/register', authLimiter, validate(registerValidation), registerController)
```
Failures return 422 with `data.errors: [{ field, message }]`.

### Errors
Throw `AppError` from a service or middleware, and wrap async controllers in `asyncHandler` so the error reaches the global error handler:
```ts
throw new AppError('Product not found', NOT_FOUND)
```
Unexpected errors are logged and returned as a generic 500 without internal details.

### Email
- Nodemailer + Handlebars: `src/modules/notifications/email.ts`
  - `sendEmail({ to, subject, template, context })`, with templates in `src/modules/views/*.handlebars`
  - Configure `EMAIL_USER` and `EMAIL_PASSWORD`
- Brevo REST: `src/modules/notifications/brevo.ts`
  - Requires `BREVO_API_KEY` and `BREVO_SENDER_EMAIL`

### File Uploads (Cloudinary)
```ts
router.post('/avatar', verify, uploadManager.single('avatar'), asyncHandler(async (req, res) => {
  const url = await uploadToCloudinary(req.file!, 'avatars')
  sendResponse(res, messageHandler('Uploaded', true, SUCCESS, { url }))
}))
```
Invalid file types return 415 and files over 10MB return 413.

### Utilities
Everything is re-exported from `utils/index.ts`:
- `response.ts`: `messageHandler`, `sendResponse`, `ServiceResponse` type
- `errors.ts`: `AppError`
- `asyncHandler.ts`: `asyncHandler` for async route handlers
- `password.ts`: `hashPassword`, `verifyPassword`, `passwordValidator`
- `token.ts`: `generateAccessToken`, `generateRefreshToken`, `verifyToken`, `getTokenExpiry`
- `crypto.ts`: `generateVerificationCode` (OTP), `generateRandomToken` (magic/reset links), `hashToken`
- `pagination.ts`: `getPagination(req.query)` → `{ page, limit, offset }`, and `paginate(findAndCountAllResult, page, limit)`
- `phone.ts`: `verifyPhoneNumber`, `sanitizePhoneNumber` (Nigerian numbers → `+234…`)

### Scripts
| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Watch mode with nodemon + tsx                  |
| `npm run build`     | Compile to `dist/` and copy email templates    |
| `npm start`         | Run the compiled server                        |
| `npm run typecheck` | Type-check without emitting                    |

### Deployment (Render)
`render.yaml` installs dev dependencies for the build, uses `/health` as the health check, and sets `TRUST_PROXY=1` so rate limiting sees real client IPs.

### Security Notes
- Store secrets in `.env` (never commit)
- Use a long random `SECRET_KEY`
- Prefer app-specific passwords for email providers
- Set `CORS_ORIGIN` to your frontend's URL in production

### Next Steps / Customization
- Add password reset and email verification flows (templates and `crypto.ts` helpers are ready)
- Extend models and relationships in Sequelize; add migrations
- Add integration tests and CI pipeline

### License
ISC
