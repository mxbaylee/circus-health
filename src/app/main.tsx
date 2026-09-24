import React from 'react';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import './styles.css';

// A data router gives note editors a blocker for browser Back/Forward as well as links.
// App retains the existing profile boundary and nested route definitions.
const router = createHashRouter([{ path: '*', element: <App /> }]);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
