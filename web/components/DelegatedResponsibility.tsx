import React from 'react';

export function DelegatedResponsibility() {
  return (
    <section id="pricing" className="py-20 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-12">
          <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            You choose how much we help
          </h2>
          <p className="mt-4 max-w-2xl text-xl text-gray-600 dark:text-gray-300">
            You can run the whole stack yourself. If you want help, we can
            operate it, set it up with you, or adapt a deployment to what you
            need.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-white dark:bg-gray-800 flex flex-col">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Fork it</h3>
            <p className="text-gray-600 dark:text-gray-300 mb-4 flex-grow">
              MIT licensed. Deploy it yourself. Anthus does nothing and charges nothing.
            </p>
            <div className="mt-auto">
              <span className="text-2xl font-bold text-gray-900 dark:text-white">No cost</span>
            </div>
          </div>

          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-white dark:bg-gray-800 flex flex-col">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Self-setup, managed</h3>
            <p className="text-gray-600 dark:text-gray-300 mb-4 flex-grow">
              You run the CloudFormation template in your account; we operate it and keep the deployment updated. We update our own organizations first.
            </p>
            <div className="mt-auto">
              <span className="text-2xl font-bold text-gray-900 dark:text-white">$20 a month</span>
            </div>
          </div>

          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-white dark:bg-gray-800 flex flex-col">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Assisted setup, managed</h3>
            <p className="text-gray-600 dark:text-gray-300 mb-4 flex-grow">
              We run the setup session with you, then operate it. We keep the deployment updated, updating our own organizations first.
            </p>
            <div className="mt-auto flex flex-col">
              <span className="text-2xl font-bold text-gray-900 dark:text-white">$20 a month</span>
              <span className="text-sm text-gray-500">and $100 once</span>
            </div>
          </div>

          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6 bg-white dark:bg-gray-800 flex flex-col">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Professional services</h3>
            <p className="text-gray-600 dark:text-gray-300 mb-4 flex-grow">
              We adapt a deployment to your exact needs, with or without the managed service.
            </p>
            <div className="mt-auto">
              <span className="text-2xl font-bold text-gray-900 dark:text-white">Quoted</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
