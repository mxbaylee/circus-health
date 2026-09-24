import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../tokens.css';
import '../../styles.css';
import { ImportReviewPresentation } from './ImportReviewPresentation';
import { initialRecords, initialReports } from './prototype-fixture';

const fixtureModel = {
  reports: initialReports,
  records: initialRecords,
  activity: {
    activeFiles: 1,
    label: 'Moxie is reading 1 file',
    detail: 'This could take a minute. You can leave this page.',
  },
};

document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main style={{ padding: '24px clamp(14px, 4vw, 48px)' }}>
      <ImportReviewPresentation model={fixtureModel} />
    </main>
  </React.StrictMode>,
);
