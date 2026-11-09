import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL || '';

const api = axios.create({ baseURL: BASE });

// Attach JWT token to every request
api.interceptors.request.use(config => {
  const token = sessionStorage.getItem('auth_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 globally — redirect to login
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      sessionStorage.removeItem('auth_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export const login = (username, password) =>
  api.post('/api/auth/login', { username, password });

export const fetchPipelines = () =>
  api.get('/api/pipelines').then(r => r.data);

export const fetchPipeline = (id) =>
  api.get(`/api/pipelines/${id}`).then(r => r.data);

export const approvePipeline = (id, comment, approved_by) =>
  api.post(`/api/pipelines/${id}/approve`, { comment, approved_by }).then(r => r.data);

export const rejectPipeline = (id, comment, approved_by) =>
  api.post(`/api/pipelines/${id}/reject`, { comment, approved_by }).then(r => r.data);

export const rerunPipeline = (id) =>
  api.post(`/api/pipelines/${id}/rerun`).then(r => r.data);

export const deployToAws = (id) =>
  api.post(`/api/pipelines/${id}/deploy-aws`).then(r => r.data);

// Cluster inspect/manage (deployed app on kind)
export const fetchCluster = (ns) =>
  api.get(`/api/cluster/${ns}`).then(r => r.data);

export const restartDeploy = (ns, deploy) =>
  api.post(`/api/cluster/${ns}/${deploy}/restart`).then(r => r.data);

export const scaleDeploy = (ns, deploy, replicas) =>
  api.post(`/api/cluster/${ns}/${deploy}/scale`, { replicas }).then(r => r.data);

export const rollbackDeploy = (ns, deploy) =>
  api.post(`/api/cluster/${ns}/${deploy}/rollback`).then(r => r.data);

export const fetchDeployLogs = (ns, deploy) =>
  api.get(`/api/cluster/${ns}/${deploy}/logs`).then(r => r.data);

export const fetchGateFindings = (id, gate) =>
  api.get(`/api/pipelines/${id}/gates/${encodeURIComponent(gate)}/findings`).then(r => r.data);

export const aiFix = (id, finding) =>
  api.post(`/api/pipelines/${id}/ai-fix`, finding).then(r => r.data);

export const acceptRisk = (id, finding) =>
  api.post(`/api/pipelines/${id}/accept-risk`, finding).then(r => r.data);

export const fetchReport = (id) =>
  api.get(`/api/reports/${id}`).then(r => r.data);

export const analyzeReport = (payload) =>
  api.post('/api/analyze', payload).then(r => r.data);

export const fetchLinks = () =>
  api.get('/api/links').then(r => r.data);

export const fetchSettings = () =>
  api.get('/api/settings').then(r => r.data);

export const updateSetting = (key, value) =>
  api.put(`/api/settings/${key}`, { value }).then(r => r.data);

// AWS Deploy Console
export const awsValidate = (creds) =>
  api.post('/api/aws/validate', creds).then(r => r.data);

export const awsDeploy = (creds) =>
  api.post('/api/aws/deploy', creds).then(r => r.data);

export const awsJobStatus = (jobId) =>
  api.get(`/api/aws/deploy/${jobId}?poll=1`).then(r => r.data);

export default api;
