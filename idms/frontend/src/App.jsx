import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import RoleSelect from './RoleSelect.jsx';
import { CoordinatorLayout } from './coordinator/Layout.jsx';
import { CoordinatorActions } from './coordinator/Actions.jsx';
import { CoordinatorPatients } from './coordinator/Patients.jsx';
import { CoordinatorDonors } from './coordinator/Donors.jsx';
import { CoordinatorInsights } from './coordinator/Insights.jsx';
import { PatientLayout } from './patient/Layout.jsx';
import { PatientDashboard } from './patient/Dashboard.jsx';
import { PatientRequestBlood } from './patient/RequestBlood.jsx';
import { PatientHistory } from './patient/History.jsx';
import { PatientNotifications } from './patient/Notifications.jsx';
import { DonorLayout } from './donor/Layout.jsx';
import { DonorNotifications } from './donor/Notifications.jsx';
import { DonorDonations } from './donor/Donations.jsx';
import { DonorProfile } from './donor/Profile.jsx';
import { DonorMessages } from './donor/Messages.jsx';
import { useToast } from './components/Toast.jsx';
import { getDonors } from './api.js';
import LoadingSpinner from './components/LoadingSpinner.jsx';

const STORAGE_KEY = 'idms_role';
const STORAGE_KEY_DONOR_ID = 'idms_donor_id';
const VALID_ROLES = ['coordinator', 'patient', 'donor'];

function normalizeRole(value) {
  return VALID_ROLES.includes(value) ? value : null;
}

export default function App() {
  const [currentRole, setCurrentRole] = useState(() => normalizeRole(localStorage.getItem(STORAGE_KEY)));
  const [donorId, setDonorId] = useState(() => localStorage.getItem(STORAGE_KEY_DONOR_ID) || null);
  const [allDonors, setAllDonors] = useState([]);
  const [loadingDonors, setLoadingDonors] = useState(false);
  const [donorsLoaded, setDonorsLoaded] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    if (currentRole) {
      localStorage.setItem(STORAGE_KEY, currentRole);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [currentRole]);

  useEffect(() => {
    if (donorId) {
      localStorage.setItem(STORAGE_KEY_DONOR_ID, donorId);
    } else {
      localStorage.removeItem(STORAGE_KEY_DONOR_ID);
    }
  }, [donorId]);

  useEffect(() => {
    if (currentRole !== 'donor' || donorsLoaded || loadingDonors) {
      return;
    }

    async function loadDonors() {
      setLoadingDonors(true);
      try {
        const data = await getDonors({ category: 'Bridge Donor', limit: 100 });
        setAllDonors(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error('Error loading donors:', err);
        setAllDonors([]);
      } finally {
        setLoadingDonors(false);
        setDonorsLoaded(true);
      }
    }

    loadDonors();
  }, [currentRole, donorsLoaded, loadingDonors]);

  const filteredDonors = useMemo(() => {
    if (!searchTerm) return allDonors;
    const lower = searchTerm.toLowerCase();
    return allDonors.filter(
      (d) =>
        (d.user_id && d.user_id.toLowerCase().includes(lower)) ||
        (d.blood_group && d.blood_group.toLowerCase().includes(lower))
    );
  }, [allDonors, searchTerm]);

  const selectedDonor = useMemo(
    () => allDonors.find((donor) => donor.user_id === donorId),
    [allDonors, donorId]
  );

  const handleSelectDonor = (selectedDonorId) => {
    setDonorId(selectedDonorId);
  };

  const roleRoutes = useMemo(() => {
    if (currentRole === 'coordinator') {
      return (
        <Routes>
          <Route path="/*" element={<CoordinatorLayout onSwitchRole={() => setCurrentRole(null)} />}>
            <Route index element={<CoordinatorActions />} />
            <Route path="patients" element={<CoordinatorPatients />} />
            <Route path="donors" element={<CoordinatorDonors />} />
            <Route path="insights" element={<CoordinatorInsights />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      );
    }
    if (currentRole === 'patient') {
      return (
        <Routes>
          <Route path="/*" element={<PatientLayout onSwitchRole={() => setCurrentRole(null)} />}>
            <Route index element={<PatientDashboard />} />
            <Route path="request" element={<PatientRequestBlood />} />
            <Route path="history" element={<PatientHistory />} />
            <Route path="notifications" element={<PatientNotifications />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      );
    }
    if (currentRole === 'donor') {
      if (!donorId) {
        return (
          <div className="app-shell donor-selector-shell">
            <div className="donor-selector-wrapper">
              <div className="donor-selector-card">
                <div className="donor-selector-header">
                  <h1>Select your donor profile</h1>
                  <p>Choose your profile to continue to your donor dashboard</p>
                </div>

                <div className="donor-selector-body">
                  {loadingDonors ? <LoadingSpinner /> : (
                    <select className="form-control" onChange={(e) => setDonorId(e.target.value)} defaultValue="">
                      <option value="" disabled>Select a donor...</option>
                      {allDonors.map((d) => (
                        <option key={d.user_id} value={d.user_id}>{d.user_id} ({d.blood_group})</option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="donor-selector-footer">
                  <button type="button" className="btn btn-ghost" onClick={() => setCurrentRole(null)}>
                    Switch role
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      }
      return (
        <Routes>
          <Route path="/*" element={<DonorLayout onSwitchRole={() => setCurrentRole(null)} donorId={donorId} />}>
            <Route index element={<DonorNotifications donorId={donorId} />} />
            <Route
              path="donations"
              element={<DonorDonations donorId={donorId} selectedDonorBloodGroup={selectedDonor?.blood_group} />}
            />
            <Route
              path="profile"
              element={<DonorProfile donorId={donorId} selectedDonorBloodGroup={selectedDonor?.blood_group} />}
            />
            <Route path="messages" element={<DonorMessages donorId={donorId} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      );
    }
    return <RoleSelect onSelectRole={setCurrentRole} />;
  }, [currentRole, donorId, loadingDonors, filteredDonors, searchTerm]);

  return <BrowserRouter>{roleRoutes}</BrowserRouter>;
}
