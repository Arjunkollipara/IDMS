import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Sidebar, Shell } from "./components";
import Dashboard from "./pages/Dashboard";
import Donors from "./pages/Donors";
import Patients from "./pages/Patients";
import Conversations from "./pages/Conversations";
import Insights from "./pages/Insights";

function Layout() {
  return (
    <Shell>
      <Sidebar />
      <main className="main-content">
        <Outlet />
      </main>
    </Shell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/donors" element={<Donors />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/conversations" element={<Conversations />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
