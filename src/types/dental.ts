/** Dental domain types — patients, appointments, clinic profiles. */

import type { ClinicId, PatientId, AppointmentId } from "./call.js";

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "checked_in"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type AppointmentType =
  | "emergency"
  | "new_patient_exam"
  | "recall_exam"
  | "cleaning"
  | "filling"
  | "crown"
  | "root_canal"
  | "extraction"
  | "consultation"
  | "follow_up"
  | "other";

export type DentalInsuranceProvider = string;

export interface Patient {
  patientId: PatientId;
  clinicId: ClinicId;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phoneNumbers: string[];
  email: string | null;
  insurance: DentalInsurance | null;
  chartNumber: string | null;
  preferredLanguage: string;
  lastVisitAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DentalInsurance {
  provider: DentalInsuranceProvider;
  groupId: string;
  memberId: string;
  relationship: "self" | "spouse" | "child" | "other";
}

export interface Appointment {
  appointmentId: AppointmentId;
  clinicId: ClinicId;
  patientId: PatientId;
  providerId: string;
  operatoryId: string;
  type: AppointmentType;
  status: AppointmentStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  durationMinutes: number;
  reason: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppointmentSlot {
  date: string;
  startTime: string;
  endTime: string;
  providerId: string;
  operatoryId: string;
  isAvailable: boolean;
}

export interface DentalFlowState {
  flowType: "emergency" | "scheduling" | "general_query";
  turnIndex: number;
  confirmations: string[];
  collectedSlots: Record<string, string>;
}
