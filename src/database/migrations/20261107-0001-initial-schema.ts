import type { QueryInterface } from 'sequelize';

// Initial Bushustlers schema. Additive only: every statement is CREATE ... IF NOT EXISTS or adds a missing
// column, so it is safe to run against a database that already has the starter template's `auths` table.
// MySQL commits DDL implicitly, which is why each step is written to be re-runnable after a partial failure.

const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
// Case-sensitive ASCII for identifiers, tokens and hashes: base62 ids must not collide by letter case.
const ID = (length: number) => `VARCHAR(${length}) CHARACTER SET ascii COLLATE ascii_bin`;

const columnExists = async (qi: QueryInterface, table: string, column: string) => {
  const [rows] = await qi.sequelize.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: [table, column] },
  );
  return Number((rows as Array<{ n: string | number }>)[0]?.n) > 0;
};

const addColumnIfMissing = async (qi: QueryInterface, table: string, column: string, definition: string) => {
  if (!(await columnExists(qi, table, column))) {
    await qi.sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
};

const statements: string[] = [
  // ---- Accounts --------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS auths (
    id INT NOT NULL AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    fullName VARCHAR(120) NULL,
    emailVerifiedAt DATETIME(3) NULL,
    passwordChangedAt DATETIME(3) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY auths_email_unique (email)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id INT NOT NULL AUTO_INCREMENT,
    publicId ${ID(24)} NOT NULL,
    userId INT NOT NULL,
    refreshTokenHash ${ID(64)} NOT NULL,
    previousTokenHash ${ID(64)} NULL,
    rotatedAt DATETIME(3) NULL,
    userAgent VARCHAR(255) NULL,
    ipAddress VARCHAR(64) NULL,
    expiresAt DATETIME(3) NOT NULL,
    lastUsedAt DATETIME(3) NULL,
    revokedAt DATETIME(3) NULL,
    revokedReason VARCHAR(40) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY auth_sessions_public_id_unique (publicId),
    KEY auth_sessions_user_idx (userId, revokedAt),
    CONSTRAINT auth_sessions_user_fk FOREIGN KEY (userId) REFERENCES auths (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS auth_tokens (
    id INT NOT NULL AUTO_INCREMENT,
    userId INT NOT NULL,
    purpose ENUM('verify_email','reset_password') NOT NULL,
    tokenHash ${ID(64)} NOT NULL,
    expiresAt DATETIME(3) NOT NULL,
    usedAt DATETIME(3) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY auth_tokens_hash_unique (tokenHash),
    KEY auth_tokens_user_purpose_idx (userId, purpose),
    CONSTRAINT auth_tokens_user_fk FOREIGN KEY (userId) REFERENCES auths (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  // ---- Businesses ------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS businesses (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    category VARCHAR(40) NOT NULL,
    phone VARCHAR(20) NULL,
    orderPrefix VARCHAR(5) NOT NULL,
    nextOrderNumber INT NOT NULL DEFAULT 101,
    settlementPreference VARCHAR(20) NOT NULL DEFAULT 'naira',
    notifyPaymentEmails TINYINT(1) NOT NULL DEFAULT 1,
    notifyReviewEmails TINYINT(1) NOT NULL DEFAULT 1,
    providerVerificationStatus ENUM('not_started','pending','verified','rejected') NOT NULL DEFAULT 'not_started',
    providerVerifiedAt DATETIME(3) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS business_members (
    id INT NOT NULL AUTO_INCREMENT,
    businessId INT NOT NULL,
    userId INT NOT NULL,
    role ENUM('owner','staff') NOT NULL DEFAULT 'owner',
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY business_members_unique (businessId, userId),
    KEY business_members_user_idx (userId),
    CONSTRAINT business_members_business_fk FOREIGN KEY (businessId) REFERENCES businesses (id) ON DELETE CASCADE,
    CONSTRAINT business_members_user_fk FOREIGN KEY (userId) REFERENCES auths (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  // ---- Commerce --------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS customers (
    id INT NOT NULL AUTO_INCREMENT,
    publicId ${ID(24)} NOT NULL,
    businessId INT NOT NULL,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(20) NULL,
    handle VARCHAR(80) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY customers_public_id_unique (publicId),
    KEY customers_business_name_idx (businessId, name),
    KEY customers_business_email_idx (businessId, email),
    KEY customers_business_phone_idx (businessId, phone),
    CONSTRAINT customers_business_fk FOREIGN KEY (businessId) REFERENCES businesses (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS orders (
    id INT NOT NULL AUTO_INCREMENT,
    publicId ${ID(24)} NOT NULL,
    businessId INT NOT NULL,
    customerId INT NULL,
    reference VARCHAR(20) NOT NULL,
    status ENUM('draft','open','expired','cancelled') NOT NULL DEFAULT 'draft',
    paymentStatus ENUM('unpaid','processing','paid','needs_review') NOT NULL DEFAULT 'unpaid',
    reviewRequired TINYINT(1) NOT NULL DEFAULT 0,
    fulfilmentStatus ENUM('unfulfilled','dispatched','delivered') NOT NULL DEFAULT 'unfulfilled',
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    subtotalMinor BIGINT NOT NULL DEFAULT 0,
    deliveryFeeMinor BIGINT NOT NULL DEFAULT 0,
    totalMinor BIGINT NOT NULL DEFAULT 0,
    amountPaidMinor BIGINT NOT NULL DEFAULT 0,
    note VARCHAR(500) NULL,
    fulfilmentNote VARCHAR(255) NULL,
    paidAt DATETIME(3) NULL,
    dispatchedAt DATETIME(3) NULL,
    deliveredAt DATETIME(3) NULL,
    cancelledAt DATETIME(3) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY orders_public_id_unique (publicId),
    UNIQUE KEY orders_business_reference_unique (businessId, reference),
    KEY orders_business_created_idx (businessId, createdAt),
    KEY orders_business_payment_idx (businessId, paymentStatus),
    KEY orders_business_status_idx (businessId, status),
    KEY orders_business_fulfilment_idx (businessId, fulfilmentStatus),
    KEY orders_customer_idx (customerId),
    CONSTRAINT orders_business_fk FOREIGN KEY (businessId) REFERENCES businesses (id) ON DELETE CASCADE,
    CONSTRAINT orders_customer_fk FOREIGN KEY (customerId) REFERENCES customers (id) ON DELETE SET NULL
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id INT NOT NULL AUTO_INCREMENT,
    orderId INT NOT NULL,
    name VARCHAR(120) NOT NULL,
    quantity INT NOT NULL,
    unitPriceMinor BIGINT NOT NULL,
    lineTotalMinor BIGINT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY order_items_order_idx (orderId),
    CONSTRAINT order_items_order_fk FOREIGN KEY (orderId) REFERENCES orders (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS payment_links (
    id INT NOT NULL AUTO_INCREMENT,
    publicId ${ID(22)} NOT NULL,
    businessId INT NOT NULL,
    orderId INT NOT NULL,
    status ENUM('active','disabled','expired','completed') NOT NULL DEFAULT 'active',
    expiresAt DATETIME(3) NOT NULL,
    disabledAt DATETIME(3) NULL,
    completedAt DATETIME(3) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY payment_links_public_id_unique (publicId),
    KEY payment_links_order_idx (orderId),
    KEY payment_links_business_status_idx (businessId, status, createdAt),
    KEY payment_links_status_expiry_idx (status, expiresAt),
    CONSTRAINT payment_links_business_fk FOREIGN KEY (businessId) REFERENCES businesses (id) ON DELETE CASCADE,
    CONSTRAINT payment_links_order_fk FOREIGN KEY (orderId) REFERENCES orders (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  // ---- Payments --------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS payment_attempts (
    id INT NOT NULL AUTO_INCREMENT,
    publicId ${ID(24)} NOT NULL,
    businessId INT NOT NULL,
    orderId INT NOT NULL,
    paymentLinkId INT NOT NULL,
    route ENUM('bank_transfer','stablecoin') NOT NULL,
    provider ENUM('busha','demo') NOT NULL,
    providerMode ENUM('demo','sandbox','production') NOT NULL,
    reference ${ID(64)} NOT NULL,
    idempotencyKey ${ID(80)} NOT NULL,
    providerReference ${ID(80)} NULL,
    providerStatus VARCHAR(40) NULL,
    status ENUM('creating','awaiting_payment','processing','confirmed','needs_review','failed','expired','cancelled') NOT NULL DEFAULT 'creating',
    reviewReason VARCHAR(40) NULL,
    reviewResolution VARCHAR(20) NULL,
    resolutionNote VARCHAR(500) NULL,
    resolvedAt DATETIME(3) NULL,
    resolvedBy INT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    expectedAmountMinor BIGINT NOT NULL,
    asset VARCHAR(10) NULL,
    network VARCHAR(16) NULL,
    assetAmount VARCHAR(40) NULL,
    rate VARCHAR(40) NULL,
    rateSource VARCHAR(20) NULL,
    payInAccountNumber VARCHAR(20) NULL,
    instructions JSON NULL,
    receivedAmount VARCHAR(40) NULL,
    receivedCurrency VARCHAR(10) NULL,
    receivedAmountMinor BIGINT NULL,
    settlementAmount VARCHAR(40) NULL,
    settlementCurrency VARCHAR(10) NULL,
    providerFees JSON NULL,
    buyerEmail VARCHAR(255) NULL,
    buyerName VARCHAR(120) NULL,
    expiresAt DATETIME(3) NULL,
    confirmedAt DATETIME(3) NULL,
    failedAt DATETIME(3) NULL,
    lastCheckedAt DATETIME(3) NULL,
    checkCount INT NOT NULL DEFAULT 0,
    failureReason VARCHAR(255) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY payment_attempts_public_id_unique (publicId),
    UNIQUE KEY payment_attempts_reference_unique (reference),
    UNIQUE KEY payment_attempts_idempotency_unique (paymentLinkId, idempotencyKey),
    UNIQUE KEY payment_attempts_provider_ref_unique (provider, providerReference),
    KEY payment_attempts_order_idx (orderId),
    KEY payment_attempts_business_created_idx (businessId, createdAt),
    KEY payment_attempts_status_checked_idx (status, lastCheckedAt),
    KEY payment_attempts_account_idx (payInAccountNumber),
    CONSTRAINT payment_attempts_business_fk FOREIGN KEY (businessId) REFERENCES businesses (id) ON DELETE CASCADE,
    CONSTRAINT payment_attempts_order_fk FOREIGN KEY (orderId) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT payment_attempts_link_fk FOREIGN KEY (paymentLinkId) REFERENCES payment_links (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS provider_events (
    id INT NOT NULL AUTO_INCREMENT,
    provider ENUM('busha','demo') NOT NULL,
    dedupeKey ${ID(64)} NOT NULL,
    eventType VARCHAR(64) NOT NULL,
    objectType VARCHAR(32) NULL,
    objectId ${ID(80)} NULL,
    paymentAttemptId INT NULL,
    payload JSON NOT NULL,
    status ENUM('received','processed','ignored','failed') NOT NULL DEFAULT 'received',
    processingAttempts INT NOT NULL DEFAULT 0,
    lastError VARCHAR(255) NULL,
    receivedAt DATETIME(3) NOT NULL,
    processedAt DATETIME(3) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY provider_events_dedupe_unique (provider, dedupeKey),
    KEY provider_events_status_idx (status, receivedAt),
    KEY provider_events_object_idx (objectId),
    KEY provider_events_attempt_idx (paymentAttemptId),
    CONSTRAINT provider_events_attempt_fk FOREIGN KEY (paymentAttemptId) REFERENCES payment_attempts (id) ON DELETE SET NULL
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS settlements (
    id INT NOT NULL AUTO_INCREMENT,
    publicId ${ID(24)} NOT NULL,
    businessId INT NOT NULL,
    orderId INT NOT NULL,
    paymentAttemptId INT NOT NULL,
    status ENUM('pending','settled','failed') NOT NULL DEFAULT 'pending',
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    grossMinor BIGINT NOT NULL,
    providerFeeMinor BIGINT NOT NULL DEFAULT 0,
    platformFeeMinor BIGINT NOT NULL DEFAULT 0,
    netMinor BIGINT NOT NULL,
    feeBasis VARCHAR(120) NOT NULL,
    payoutReference VARCHAR(80) NULL,
    settledAt DATETIME(3) NULL,
    failureReason VARCHAR(255) NULL,
    simulated TINYINT(1) NOT NULL DEFAULT 0,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY settlements_public_id_unique (publicId),
    UNIQUE KEY settlements_attempt_unique (paymentAttemptId),
    KEY settlements_business_status_idx (businessId, status, createdAt),
    CONSTRAINT settlements_business_fk FOREIGN KEY (businessId) REFERENCES businesses (id) ON DELETE CASCADE,
    CONSTRAINT settlements_order_fk FOREIGN KEY (orderId) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT settlements_attempt_fk FOREIGN KEY (paymentAttemptId) REFERENCES payment_attempts (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  // Append-only history; no foreign keys so entries outlive the rows they describe.
  `CREATE TABLE IF NOT EXISTS audit_events (
    id INT NOT NULL AUTO_INCREMENT,
    businessId INT NULL,
    orderId INT NULL,
    entityType VARCHAR(32) NOT NULL,
    entityId INT NULL,
    action VARCHAR(64) NOT NULL,
    actorType ENUM('user','buyer','provider','system') NOT NULL,
    actorId INT NULL,
    fromStatus VARCHAR(40) NULL,
    toStatus VARCHAR(40) NULL,
    metadata JSON NULL,
    requestId VARCHAR(64) NULL,
    createdAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY audit_events_order_idx (orderId, createdAt),
    KEY audit_events_business_idx (businessId, createdAt),
    KEY audit_events_entity_idx (entityType, entityId)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS email_outbox (
    id INT NOT NULL AUTO_INCREMENT,
    toEmail VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    template VARCHAR(64) NOT NULL,
    status ENUM('sent','failed','captured') NOT NULL,
    html MEDIUMTEXT NULL,
    error VARCHAR(255) NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY email_outbox_created_idx (createdAt)
  ) ${TABLE_OPTIONS}`,

  // Only used by the explicit local demo provider: it stands in for the provider's own records.
  `CREATE TABLE IF NOT EXISTS demo_provider_objects (
    id INT NOT NULL AUTO_INCREMENT,
    providerReference ${ID(80)} NOT NULL,
    kind ENUM('transfer','payment_request') NOT NULL,
    status VARCHAR(40) NOT NULL,
    reference ${ID(64)} NOT NULL,
    requestedAmount VARCHAR(40) NOT NULL,
    requestedCurrency VARCHAR(10) NOT NULL,
    sourceAmount VARCHAR(40) NOT NULL,
    sourceCurrency VARCHAR(10) NOT NULL,
    targetAmount VARCHAR(40) NOT NULL,
    targetCurrency VARCHAR(10) NOT NULL,
    receivedAmount VARCHAR(40) NULL,
    network VARCHAR(16) NULL,
    address VARCHAR(120) NULL,
    expiresAt DATETIME(3) NOT NULL,
    createdAt DATETIME(3) NOT NULL,
    updatedAt DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY demo_provider_objects_ref_unique (providerReference)
  ) ${TABLE_OPTIONS}`,
];

export const up = async (qi: QueryInterface) => {
  for (const statement of statements) {
    await qi.sequelize.query(statement);
  }
  // If `auths` already existed (created by the starter template's sync()), add the new columns
  // and relax the legacy refresh-token columns that sessions replace.
  await addColumnIfMissing(qi, 'auths', 'fullName', 'VARCHAR(120) NULL');
  await addColumnIfMissing(qi, 'auths', 'emailVerifiedAt', 'DATETIME(3) NULL');
  await addColumnIfMissing(qi, 'auths', 'passwordChangedAt', 'DATETIME(3) NULL');
  if (await columnExists(qi, 'auths', 'refreshToken')) {
    await qi.sequelize.query('ALTER TABLE `auths` MODIFY `refreshToken` TEXT NULL');
  }
};

// Destructive: only the migrate CLI's local-development path may call this.
export const down = async (qi: QueryInterface) => {
  const tables = [
    'demo_provider_objects', 'email_outbox', 'audit_events', 'settlements', 'provider_events', 'payment_attempts',
    'payment_links', 'order_items', 'orders', 'customers', 'business_members', 'businesses', 'auth_tokens', 'auth_sessions',
  ];
  for (const table of tables) {
    await qi.sequelize.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
};
