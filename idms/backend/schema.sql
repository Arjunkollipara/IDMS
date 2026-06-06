-- Drop tables if they exist (for idempotency)
DROP TABLE IF EXISTS conversation_history CASCADE;
DROP TABLE IF EXISTS learning_log CASCADE;
DROP TABLE IF EXISTS notifications_log CASCADE;
DROP TABLE IF EXISTS reservation_log CASCADE;
DROP TABLE IF EXISTS escalation_log CASCADE;
DROP TABLE IF EXISTS escalation_pool CASCADE;
DROP TABLE IF EXISTS bridges CASCADE;
DROP TABLE IF EXISTS patients CASCADE;
DROP TABLE IF EXISTS donors CASCADE;

-- Donors Table
CREATE TABLE donors (
    user_id VARCHAR PRIMARY KEY,
    blood_group VARCHAR,
    gender VARCHAR,
    latitude FLOAT,
    longitude FLOAT,
    last_donation_date TIMESTAMP,
    next_eligible_date TIMESTAMP,
    donations_till_date INTEGER,
    eligibility_status VARCHAR,
    total_calls INTEGER,
    calls_to_donations_ratio FLOAT,
    normalized_reliability_score FLOAT,
    user_donation_active_status VARCHAR,
    inactive_trigger_comment VARCHAR,
    registration_date TIMESTAMP,
    last_contacted_date TIMESTAMP,
    donor_type VARCHAR,
    donor_category VARCHAR,
    cycle_of_donations INTEGER,
    frequency_in_days INTEGER,
    status VARCHAR,
    donated_earlier BOOLEAN,
    role_status BOOLEAN,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_donors_blood_group ON donors(blood_group);
CREATE INDEX idx_donors_donor_category ON donors(donor_category);
CREATE INDEX idx_donors_status ON donors(user_donation_active_status);

-- Patients Table
CREATE TABLE patients (
    patient_id VARCHAR PRIMARY KEY,
    blood_group VARCHAR,
    gender VARCHAR,
    latitude FLOAT,
    longitude FLOAT,
    quantity_required INTEGER DEFAULT 1,
    frequency_in_days INTEGER DEFAULT 21,
    last_transfusion_date TIMESTAMP,
    expected_next_transfusion_date TIMESTAMP,
    status VARCHAR DEFAULT 'active',
    registration_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_patients_blood_group ON patients(blood_group);
CREATE INDEX idx_patients_status ON patients(status);

-- Bridges Table
CREATE TABLE bridges (
    id SERIAL PRIMARY KEY,
    bridge_id VARCHAR,
    donor_id VARCHAR REFERENCES donors(user_id),
    patient_id VARCHAR,
    donations_till_date INTEGER,
    last_bridge_donation_date TIMESTAMP,
    status_of_bridge BOOLEAN,
    role VARCHAR,
    role_status BOOLEAN,
    bridge_blood_group VARCHAR,
    chain_position INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(bridge_id, donor_id)
);

CREATE INDEX idx_bridges_bridge_id ON bridges(bridge_id);
CREATE INDEX idx_bridges_patient_id ON bridges(patient_id);
CREATE INDEX idx_bridges_donor_id ON bridges(donor_id);

-- Escalation Pool Table
CREATE TABLE escalation_pool (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR,
    donor_id VARCHAR,
    pool_stage INTEGER,
    blood_group VARCHAR,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(patient_id, donor_id)
);

CREATE INDEX idx_escalation_pool_patient ON escalation_pool(patient_id);
CREATE INDEX idx_escalation_pool_stage ON escalation_pool(pool_stage);

-- Escalation Log Table
CREATE TABLE escalation_log (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR,
    bridge_id VARCHAR,
    trigger_date TIMESTAMP,
    stage INTEGER,
    action_taken VARCHAR,
    outcome VARCHAR,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_escalation_log_patient ON escalation_log(patient_id);

-- Reservation Log Table
CREATE TABLE reservation_log (
    id SERIAL PRIMARY KEY,
    bridge_id VARCHAR,
    patient_id VARCHAR,
    donor_id VARCHAR,
    reserved_at TIMESTAMP DEFAULT NOW(),
    transfusion_date TIMESTAMP,
    status VARCHAR DEFAULT 'reserved'
);

CREATE INDEX idx_reservation_log_patient ON reservation_log(patient_id);
CREATE INDEX idx_reservation_log_donor ON reservation_log(donor_id);

-- Notifications Log Table
CREATE TABLE notifications_log (
    id SERIAL PRIMARY KEY,
    donor_id VARCHAR,
    patient_id VARCHAR,
    message TEXT,
    sent_at TIMESTAMP DEFAULT NOW(),
    response VARCHAR,
    responded_at TIMESTAMP,
    channel VARCHAR DEFAULT 'sms',
    notification_type VARCHAR
);

CREATE INDEX idx_notifications_donor ON notifications_log(donor_id);
CREATE INDEX idx_notifications_patient ON notifications_log(patient_id);

-- Conversation History Table
CREATE TABLE conversation_history (
    id SERIAL PRIMARY KEY,
    donor_id VARCHAR,
    patient_id VARCHAR,
    role VARCHAR,
    message TEXT,
    timestamp TIMESTAMP DEFAULT NOW(),
    conversation_stage VARCHAR
);

CREATE INDEX idx_conversation_donor ON conversation_history(donor_id);
CREATE INDEX idx_conversation_patient ON conversation_history(patient_id);

-- Learning Log Table
CREATE TABLE learning_log (
    id SERIAL PRIMARY KEY,
    cycle_date TIMESTAMP,
    patient_id VARCHAR,
    stages_needed INTEGER,
    donors_contacted INTEGER,
    donors_responded INTEGER,
    donors_donated INTEGER,
    pattern_notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_learning_log_patient ON learning_log(patient_id);
