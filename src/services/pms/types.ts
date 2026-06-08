/**
 * PMS (Practice Management System) adapter interface.
 *
 * Clinics use different PMS platforms (Open Dental, Dentrix,
 * Eaglesoft, Curve Hero, etc.). This adapter lets the orchestrator
 * query patients and book appointments without coupling to any
 * single vendor.
 */

import type { ClinicId, PatientId, AppointmentId } from "../../types/call.js";
import type {
  Patient,
  Appointment,
  AppointmentType,
  AppointmentSlot,
} from "../../types/dental.js";

export type PmsProvider = "open_dental" | "dentrix" | "eaglesoft" | "curve";

export interface PmsPagination {
  limit: number;
  offset: number;
}

export interface PmsSlotQuery {
  clinicId: ClinicId;
  providerId?: string;
  appointmentType: AppointmentType;
  startDate: string;
  endDate: string;
  durationMinutes: number;
}

export interface PmsCreateAppointmentInput {
  clinicId: ClinicId;
  patientId: PatientId;
  providerId: string;
  operatoryId: string;
  type: AppointmentType;
  startTime: string;
  endTime: string;
  reason?: string;
  notes?: string;
}

export interface PmsPatientLookup {
  clinicId: ClinicId;
  firstName?: string;
  lastName?: string;
  phone?: string;
  dateOfBirth?: string;
}

/**
 * Every PMS adapter must implement this contract.
 *
 * A production adapter will likely bridge to the PMS via:
 *  - A local agent installed at the clinic
 *  - The PMS vendor's API (where available)
 *  - HL7 / FHIR integration (hospital-grade clinics)
 */
export interface PmsAdapter {
  readonly provider: PmsProvider;

  /** Verify connectivity to the PMS. */
  healthCheck(): Promise<boolean>;

  /** Look up a patient by partial demographics. */
  findPatients(
    lookup: PmsPatientLookup,
    pagination: PmsPagination,
  ): Promise<Patient[]>;

  /** Fetch a single patient record. */
  getPatient(clinicId: ClinicId, patientId: PatientId): Promise<Patient | null>;

  /** Create or update a patient record (for new-patient flows). */
  upsertPatient(patient: Patient): Promise<Patient>;

  /** Get available appointment slots. */
  getAvailableSlots(query: PmsSlotQuery): Promise<AppointmentSlot[]>;

  /** Book (create) an appointment. */
  createAppointment(
    input: PmsCreateAppointmentInput,
  ): Promise<Appointment>;

  /** Cancel an existing appointment. */
  cancelAppointment(
    clinicId: ClinicId,
    appointmentId: AppointmentId,
  ): Promise<void>;

  /** Get (sync back) an appointment after it's booked. */
  getAppointment(
    clinicId: ClinicId,
    appointmentId: AppointmentId,
  ): Promise<Appointment | null>;
}
