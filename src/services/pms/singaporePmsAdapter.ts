/**
 * Singapore PMS adapter — bridges the Voice AI to Singapore clinic PMS APIs.
 *
 * Supports Plato, Klinify, ClinicAssist, and MediSYS. Each vendor exposes
 * a REST API for patient and appointment management. This adapter implements
 * the PmsAdapter interface and translates Voice AI domain types into
 * vendor-agnostic REST calls.
 *
 * Auth: API key via the Authorization header.
 */

import {
  type PmsAdapter,
  type PmsProvider,
  type PmsPagination,
  type PmsSlotQuery,
  type PmsCreateAppointmentInput,
  type PmsPatientLookup,
} from "./types.js";
import type { ClinicId, PatientId, AppointmentId } from "../../types/call.js";
import type {
  Patient,
  Appointment,
  AppointmentSlot,
} from "../../types/dental.js";
import { safeLog } from "../../infrastructure/logging/redactor.js";

// ── Singapore PMS API types ─────────────────────────────────────

interface SgPatient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phoneNumbers: string[];
  email: string | null;
  nric: string | null;
  chartNumber: string | null;
  preferredLanguage: string;
  lastVisitAt: string | null;
  isActive: boolean;
}

interface SgAppointment {
  id: string;
  patientId: string;
  providerId: string;
  operatoryId: string;
  clinicId: string;
  appointmentType: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  durationMinutes: number;
  reason: string | null;
  notes: string | null;
}

interface SgScheduleSlot {
  providerId: string;
  operatoryId: string;
  date: string;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

interface SgApiList<T> {
  data: T[];
  totalCount: number;
}

// ── Adapter ──────────────────────────────────────────────────────

export class SingaporePmsAdapter implements PmsAdapter {
  readonly provider: PmsProvider;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private pmsProvider: PmsProvider = "plato",
  ) {
    this.provider = pmsProvider;
  }

  // ── Health ────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await this.fetch("/api/v1/health");
      return resp.ok;
    } catch {
      return false;
    }
  }

  // ── Patients ──────────────────────────────────────────────────

  async findPatients(
    lookup: PmsPatientLookup,
    pagination: PmsPagination,
  ): Promise<Patient[]> {
    const params = new URLSearchParams();
    if (lookup.firstName) params.set("firstName", lookup.firstName);
    if (lookup.lastName) params.set("lastName", lookup.lastName);
    if (lookup.phone) params.set("phone", lookup.phone);
    if (lookup.dateOfBirth) params.set("dateOfBirth", lookup.dateOfBirth);
    params.set("limit", String(pagination.limit));
    params.set("offset", String(pagination.offset));

    const resp = await this.fetch(`/api/v1/patients?${params.toString()}`);
    if (!resp.ok) return [];

    const data = (await resp.json()) as SgApiList<SgPatient>;
    return data.data.map((p) => this.toPatient(lookup.clinicId, p));
  }

  async getPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<Patient | null> {
    const resp = await this.fetch(`/api/v1/patients/${patientId}`);
    if (!resp.ok) return null;
    const p = (await resp.json()) as SgPatient;
    return this.toPatient(clinicId, p);
  }

  async upsertPatient(patient: Patient): Promise<Patient> {
    const body = this.toSgPatient(patient);
    const resp = await this.fetch("/api/v1/patients", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Singapore PMS upsert failed: ${resp.status}`);
    }
    const p = (await resp.json()) as SgPatient;
    return this.toPatient(patient.clinicId, p);
  }

  // ── Appointments ──────────────────────────────────────────────

  async getAvailableSlots(query: PmsSlotQuery): Promise<AppointmentSlot[]> {
    const params = new URLSearchParams();
    params.set("startDate", query.startDate);
    params.set("endDate", query.endDate);
    if (query.providerId) params.set("providerId", query.providerId);
    params.set("appointmentType", query.appointmentType);
    params.set("durationMinutes", String(query.durationMinutes));

    const resp = await this.fetch(`/api/v1/slots?${params.toString()}`);
    if (!resp.ok) return [];

    const data = (await resp.json()) as SgApiList<SgScheduleSlot>;
    return data.data.map((s) => ({
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      providerId: s.providerId,
      operatoryId: s.operatoryId,
      isAvailable: s.isAvailable,
    }));
  }

  async createAppointment(
    input: PmsCreateAppointmentInput,
  ): Promise<Appointment> {
    const body = {
      patientId: input.patientId,
      providerId: input.providerId,
      operatoryId: input.operatoryId,
      appointmentType: input.type,
      scheduledStart: input.startTime,
      scheduledEnd: input.endTime,
      reason: input.reason ?? "",
      notes: input.notes ?? "",
      status: "confirmed",
    };

    const resp = await this.fetch("/api/v1/appointments", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Singapore PMS create appointment failed: ${resp.status}`);
    }
    const a = (await resp.json()) as SgAppointment;
    return this.toAppointment(input.clinicId, input.patientId, a);
  }

  async cancelAppointment(
    clinicId: ClinicId,
    appointmentId: AppointmentId,
  ): Promise<void> {
    await this.fetch(`/api/v1/appointments/${appointmentId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "cancelled" }),
    });
    safeLog("info", "Appointment cancelled in PMS", {
      callId: clinicId,
      context: { appointmentId: appointmentId },
    });
  }

  async getAppointment(
    clinicId: ClinicId,
    appointmentId: AppointmentId,
  ): Promise<Appointment | null> {
    const resp = await this.fetch(`/api/v1/appointments/${appointmentId}`);
    if (!resp.ok) return null;
    const a = (await resp.json()) as SgAppointment;
    return this.toAppointment(
      clinicId,
      a.patientId as PatientId,
      a,
    );
  }

  // ── Internal helpers ──────────────────────────────────────────

  private async fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "X-PMS-Provider": this.provider,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  }

  private toPatient(clinicId: ClinicId, p: SgPatient): Patient {
    return {
      patientId: p.id as PatientId,
      clinicId,
      firstName: p.firstName,
      lastName: p.lastName,
      dateOfBirth: p.dateOfBirth,
      phoneNumbers: p.phoneNumbers,
      email: p.email ?? null,
      insurance: null,
      chartNumber: p.chartNumber ?? null,
      preferredLanguage: p.preferredLanguage || "en",
      lastVisitAt: p.lastVisitAt ? new Date(p.lastVisitAt) : null,
      isActive: p.isActive,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private toSgPatient(p: Patient): Record<string, unknown> {
    return {
      firstName: p.firstName,
      lastName: p.lastName,
      dateOfBirth: p.dateOfBirth,
      phoneNumbers: p.phoneNumbers,
      chartNumber: p.chartNumber ?? "",
      preferredLanguage: p.preferredLanguage,
    };
  }

  private toAppointment(
    clinicId: ClinicId,
    patientId: PatientId,
    a: SgAppointment,
  ): Appointment {
    return {
      appointmentId: a.id as AppointmentId,
      clinicId,
      patientId,
      providerId: a.providerId,
      operatoryId: a.operatoryId,
      type: "consultation",
      status: "scheduled",
      scheduledStart: new Date(a.scheduledStart),
      scheduledEnd: new Date(a.scheduledEnd),
      durationMinutes: a.durationMinutes,
      reason: a.reason ?? "",
      notes: a.notes ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
}
