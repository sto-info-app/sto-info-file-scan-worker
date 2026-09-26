import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { FileScanAttemptState } from '../enums/file-scan-attempt-state.enum';

/**
 * One attempt to scan one object.
 *
 * The successor to `upload_files`, renamed because the name was wrong.
 * ADR-0015 made `file_asset` in the backend the record of an upload and the
 * only thing that decides publication; what is left here is the record of a
 * scan, which is a different and much narrower claim. Nothing in this table
 * can make a byte serveable.
 *
 * It lives in its own schema, `sto_info_worker`, in the same database as the
 * registry. ADR-0006 gave the two repositories separate migration ownership
 * and warned that "two migration owners against one database needs care".
 * Separate schemas are that care: neither side can collide with the other's
 * table names and each keeps its own migration table, while a foreign key
 * across the two still holds the relationship that ADR-0015 said nothing was
 * enforcing.
 *
 * ## The idempotency key
 *
 * `(assetId, objectVersion, policyVersion, definitionEpoch)` is unique, which
 * is ADR-0006 decision 4 written as a constraint. A queue that delivers
 * at least once will sometimes deliver twice, and the second delivery finds
 * the first attempt rather than making another one.
 *
 * The constraint is declared `NULLS NOT DISTINCT`, and that is load-bearing
 * rather than incidental. R2 has no object versioning, so `objectVersion` is
 * null for every row this table will ever hold, and under PostgreSQL's
 * default two nulls are different from each other — the constraint would have
 * matched nothing at all and every duplicate delivery would have inserted a
 * second attempt. It is the sort of index that looks correct in a migration
 * and does nothing in production.
 *
 * ## The lease
 *
 * BullMQ has its own lock, and it is not enough on its own. A lock says which
 * worker may process a job; it does not say which worker's answer the
 * database will accept. A worker that stalls long enough for its lock to
 * expire, then wakes and writes, would otherwise overwrite the answer of the
 * worker that replaced it. So a claim writes a fresh {@link leaseToken}, and
 * every completion is a compare-and-set against it. A stale worker updates
 * no rows and, finding that, says nothing.
 */
@Entity({ name: 'file_scan_attempt' })
@Index('IDX_file_scan_attempt_asset', ['assetId'])
@Index('IDX_file_scan_attempt_reclaim', ['state', 'leaseExpiresAt'])
export class FileScanAttemptEntity {
  /** The attempt's own identifier, carried in the verdict. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The asset in the backend's registry.
   *
   * A foreign key across the schema boundary, `ON DELETE RESTRICT`. The
   * registry row is what tells the retention cron an object exists; an
   * attempt that outlived it would be a verdict about nothing.
   */
  @Column({ type: 'uuid', nullable: false })
  assetId: string;

  /** Where the bytes were, within the quarantine bucket. */
  @Column({ type: 'varchar', length: 1024, nullable: false })
  objectKey: string;

  /** The store's version of the object. Null on R2, which has none. */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  objectVersion: string | null;

  /** The SHA-256 the registry recorded when the bytes were stored. */
  @Column({ type: 'char', length: 64, nullable: false })
  expectedSha256: string;

  /**
   * The SHA-256 of the bytes this attempt actually read.
   *
   * Null until the read finishes, and null for ever on an attempt that never
   * got that far. A `CLEAN` row must carry one equal to
   * {@link expectedSha256}, and the database refuses a row that does not —
   * which is what makes "the scanner cleared exactly these bytes" a fact
   * about the schema rather than a property of the code that wrote it.
   */
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  observedSha256: string | null;

  /** How many bytes were read. */
  @Column({ type: 'bigint', nullable: true, default: null })
  byteSize: string | null;

  /**
   * What the object's first bytes looked like.
   *
   * Recorded, never acted on. The worker cannot know what type was expected
   * — the request does not say — so this is evidence for whoever later asks
   * what was actually uploaded, and for FC-012 to compare against what the
   * feature thought it was accepting.
   */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  detectedContentType: string | null;

  /** Which scanning policy was applied. */
  @Column({ type: 'int', nullable: false })
  policyVersion: number;

  /** Which signature database answered. Part of the idempotency key. */
  @Column({ type: 'varchar', length: 255, nullable: false })
  definitionEpoch: string;

  /** The rescan campaign this belongs to, when it belongs to one. */
  @Column({ type: 'uuid', nullable: true, default: null })
  campaignId: string | null;

  /** Carried from the request into the verdict. */
  @Column({ type: 'uuid', nullable: false })
  traceId: string;

  /** Where the attempt has got to. */
  @Column({
    type: 'enum',
    enum: FileScanAttemptState,
    enumName: 'file_scan_attempt_state_enum',
    nullable: false,
  })
  state: FileScanAttemptState;

  /**
   * Why the attempt refused.
   *
   * Administrator-only, always. A reader whose upload is refused is told that
   * it was refused — ADR-0005 decision 6.
   */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  rejectionCode: string | null;

  /**
   * What went wrong, for somebody with access to this table.
   *
   * A signature name belongs here and nowhere a reader can reach.
   */
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  failureReason: string | null;

  /** The scanner that answered. */
  @Column({ type: 'varchar', length: 100, nullable: false })
  engine: string;

  /** Its version, or null when it did not say. Never a plausible guess. */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  engineVersion: string | null;

  /** Its signature database's version, or null when it did not say. */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  signatureVersion: string | null;

  /**
   * When its signature database was built, or null when it did not say.
   *
   * What "how old were the signatures" is answered from on the admin
   * diagnostics page.
   */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  definitionsBuiltAt: Date | null;

  /** How many times this attempt has been claimed. */
  @Column({ type: 'int', nullable: false, default: 0 })
  attemptCount: number;

  /**
   * The token a completion must present.
   *
   * Cleared when the attempt finishes, so a terminal row holds no lease and
   * cannot be completed a second time.
   */
  @Column({ type: 'uuid', nullable: true, default: null })
  leaseToken: string | null;

  /** When the lease lapses and another worker may take the attempt. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  leaseExpiresAt: Date | null;

  /** When the holder last said it was still working. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  heartbeatAt: Date | null;

  /**
   * When the backend queued the request, taken from the job itself.
   *
   * Null on attempts made before it was recorded. The wait the diagnostics
   * page reports runs from here, because `createdAt` is only when a worker
   * picked the job up.
   */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  requestedAt: Date | null;

  /** When the scanner was handed the bytes. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  startedAt: Date | null;

  /** When the attempt reached a state it will not leave. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  completedAt: Date | null;

  /**
   * When the verdict was put on the queue for the backend.
   *
   * The one column a terminal row may still change, and only from null. A
   * completed attempt whose verdict was never published is the row an
   * operator sweeps for after a Redis loss — ADR-0006 names re-enqueuing from
   * the database as the recovery path, and this is the column that makes it
   * findable.
   */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  verdictPublishedAt: Date | null;

  /** When the row was written. */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** When the row last changed. */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
