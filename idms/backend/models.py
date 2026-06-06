from sqlalchemy import Column, String, Float, Integer, Boolean, DateTime, Text, ForeignKey, UniqueConstraint, Index
from sqlalchemy.ext.declarative import declarative_base
from datetime import datetime

Base = declarative_base()


class Donor(Base):
    __tablename__ = "donors"

    user_id = Column(String, primary_key=True)
    blood_group = Column(String, nullable=True)
    gender = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    last_donation_date = Column(DateTime, nullable=True)
    next_eligible_date = Column(DateTime, nullable=True)
    donations_till_date = Column(Integer, nullable=True)
    eligibility_status = Column(String, nullable=True)
    total_calls = Column(Integer, nullable=True)
    calls_to_donations_ratio = Column(Float, nullable=True)
    normalized_reliability_score = Column(Float, nullable=True)
    user_donation_active_status = Column(String, nullable=True)
    inactive_trigger_comment = Column(String, nullable=True)
    registration_date = Column(DateTime, nullable=True)
    last_contacted_date = Column(DateTime, nullable=True)
    donor_type = Column(String, nullable=True)
    donor_category = Column(String, nullable=True)
    cycle_of_donations = Column(Integer, nullable=True)
    frequency_in_days = Column(Integer, nullable=True)
    status = Column(String, nullable=True)
    donated_earlier = Column(Boolean, nullable=True)
    role_status = Column(Boolean, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("idx_donors_blood_group", "blood_group"),
        Index("idx_donors_donor_category", "donor_category"),
        Index("idx_donors_status", "user_donation_active_status"),
    )


class Patient(Base):
    __tablename__ = "patients"

    patient_id = Column(String, primary_key=True)
    blood_group = Column(String, nullable=True)
    gender = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    quantity_required = Column(Integer, default=1)
    frequency_in_days = Column(Integer, default=21)
    last_transfusion_date = Column(DateTime, nullable=True)
    expected_next_transfusion_date = Column(DateTime, nullable=True)
    status = Column(String, default="active")
    registration_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("idx_patients_blood_group", "blood_group"),
        Index("idx_patients_status", "status"),
    )


class Bridge(Base):
    __tablename__ = "bridges"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bridge_id = Column(String, nullable=True)
    donor_id = Column(String, ForeignKey("donors.user_id"), nullable=True)
    patient_id = Column(String, nullable=True)
    donations_till_date = Column(Integer, nullable=True)
    last_bridge_donation_date = Column(DateTime, nullable=True)
    status_of_bridge = Column(Boolean, nullable=True)
    role = Column(String, nullable=True)
    role_status = Column(Boolean, nullable=True)
    bridge_blood_group = Column(String, nullable=True)
    chain_position = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("bridge_id", "donor_id", name="unique_bridge_donor"),
        Index("idx_bridges_bridge_id", "bridge_id"),
        Index("idx_bridges_patient_id", "patient_id"),
        Index("idx_bridges_donor_id", "donor_id"),
    )


class EscalationPool(Base):
    __tablename__ = "escalation_pool"

    id = Column(Integer, primary_key=True, autoincrement=True)
    patient_id = Column(String, nullable=True)
    donor_id = Column(String, nullable=True)
    pool_stage = Column(Integer, nullable=True)
    blood_group = Column(String, nullable=True)
    added_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("patient_id", "donor_id", name="unique_patient_donor"),
        Index("idx_escalation_pool_patient", "patient_id"),
        Index("idx_escalation_pool_stage", "pool_stage"),
    )


class EscalationLog(Base):
    __tablename__ = "escalation_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    patient_id = Column(String, nullable=True)
    bridge_id = Column(String, nullable=True)
    trigger_date = Column(DateTime, nullable=True)
    stage = Column(Integer, nullable=True)
    action_taken = Column(String, nullable=True)
    outcome = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (Index("idx_escalation_log_patient", "patient_id"),)


class ReservationLog(Base):
    __tablename__ = "reservation_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bridge_id = Column(String, nullable=True)
    patient_id = Column(String, nullable=True)
    donor_id = Column(String, nullable=True)
    reserved_at = Column(DateTime, default=datetime.utcnow)
    transfusion_date = Column(DateTime, nullable=True)
    original_next_eligible_date = Column(DateTime, nullable=True)
    status = Column(String, default="reserved")

    __table_args__ = (
        Index("idx_reservation_log_patient", "patient_id"),
        Index("idx_reservation_log_donor", "donor_id"),
    )


class NotificationsLog(Base):
    __tablename__ = "notifications_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    donor_id = Column(String, nullable=True)
    patient_id = Column(String, nullable=True)
    message = Column(Text, nullable=True)
    sent_at = Column(DateTime, default=datetime.utcnow)
    response = Column(String, nullable=True)
    responded_at = Column(DateTime, nullable=True)
    channel = Column(String, default="sms")
    notification_type = Column(String, nullable=True)

    __table_args__ = (
        Index("idx_notifications_donor", "donor_id"),
        Index("idx_notifications_patient", "patient_id"),
    )


class ConversationHistory(Base):
    __tablename__ = "conversation_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    donor_id = Column(String, nullable=True)
    patient_id = Column(String, nullable=True)
    role = Column(String, nullable=True)
    message = Column(Text, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    conversation_stage = Column(String, nullable=True)

    __table_args__ = (
        Index("idx_conversation_donor", "donor_id"),
        Index("idx_conversation_patient", "patient_id"),
    )


class LearningLog(Base):
    __tablename__ = "learning_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    cycle_date = Column(DateTime, nullable=True)
    patient_id = Column(String, nullable=True)
    stages_needed = Column(Integer, nullable=True)
    donors_contacted = Column(Integer, nullable=True)
    donors_responded = Column(Integer, nullable=True)
    donors_donated = Column(Integer, nullable=True)
    pattern_notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (Index("idx_learning_log_patient", "patient_id"),)
