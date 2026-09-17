import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ExpectedFileType = 'FLEET_CSV' | 'IMAGE_UPLOAD';

export type FileScanStatus =
  | 'UPLOADED'
  | 'VALIDATING'
  | 'VALIDATION_FAILED'
  | 'SCANNING'
  | 'INFECTED'
  | 'PASSED'
  | 'ERROR';

@Entity({ name: 'upload_files' })
export class UploadFileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'text' })
  env!: string; // prod/dev/local

  @Column({ type: 'text' })
  r2_key!: string;

  @Column({ type: 'text' })
  original_filename!: string;

  @Column({ type: 'text' })
  expected_file_type!: ExpectedFileType;

  @Column({ type: 'text', default: 'UPLOADED' })
  scan_status!: FileScanStatus;

  @Column({ type: 'text', nullable: true })
  file_type_detected!: string | null;

  @Column({ type: 'text', nullable: true })
  file_type_reason!: string | null;

  @Column({ type: 'text', nullable: true })
  scan_engine!: string | null;

  @Column({ type: 'text', nullable: true })
  scan_engine_version!: string | null;

  @Column({ type: 'text', nullable: true })
  scan_signature_version!: string | null;

  @Column({ type: 'text', nullable: true })
  scan_error!: string | null;

  @Column({ type: 'int', default: 0 })
  attempt_count!: number;

  @Column({ type: 'timestamptz', nullable: true })
  validation_started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  validation_completed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  scan_started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  scan_completed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
