import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import DashboardPage  from './pages/DashboardPage.jsx';
import PipelinePage   from './pages/PipelinePage.jsx';
import ApprovalPage   from './pages/ApprovalPage.jsx';
import ReportsPage    from './pages/ReportsPage.jsx';
import LinksPage      from './pages/LinksPage.jsx';
import SettingsPage   from './pages/SettingsPage.jsx';
import AwsDeployPage  from './pages/AwsDeployPage.jsx';
import ClusterPage    from './pages/ClusterPage.jsx';
import LoginPage      from './pages/LoginPage.jsx';

function NavBar() {
  return (
    <nav className="nav">
      <span className="nav-brand">ShieldOps</span>
      <NavLink className={({isActive}) => 'nav-link' + (isActive ? ' active' : '')} to="/">Dashboard</NavLink>
      <NavLink className={({isActive}) => 'nav-link' + (isActive ? ' active' : '')} to="/approvals">Approvals</NavLink>
      <NavLink className={({isActive}) => 'nav-link' + (isActive ? ' active' : '')} to="/reports">Reports</NavLink>
      <NavLink className={({isActive}) => 'nav-link' + (isActive ? ' active' : '')} to="/app">App</NavLink>
      <NavLink className={({isActive}) => 'nav-link' + (isActive ? ' active' : '')} to="/links">Links</NavLink>
      <NavLink className={({isActive}) => 'nav-link' + (isActive ? ' active' : '')} to="/aws-deploy">AWS Deploy</NavLink>
      <NavLink className={({isActive}) => 'nav-link' + (isActive ? ' active' : '')} to="/settings">Settings</NavLink>
    </nav>
  );
}

function PrivateRoute({ children }) {
  const token = sessionStorage.getItem('auth_token');
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={
          <PrivateRoute>
            <>
              <NavBar />
              <Routes>
                <Route path="/"              element={<DashboardPage />} />
                <Route path="/pipelines/:id" element={<PipelinePage />} />
                <Route path="/approvals"     element={<ApprovalPage />} />
                <Route path="/approvals/:id" element={<ApprovalPage />} />
                <Route path="/reports"       element={<ReportsPage />} />
                <Route path="/links"         element={<LinksPage />} />
                <Route path="/settings"      element={<SettingsPage />} />
                <Route path="/aws-deploy"    element={<AwsDeployPage />} />
                <Route path="/app"           element={<ClusterPage />} />
                <Route path="*"              element={<Navigate to="/" replace />} />
              </Routes>
            </>
          </PrivateRoute>
        } />
      </Routes>
    </BrowserRouter>
  );
}
