// Image resizer using Web Worker with OffscreenCanvas
// Provides a clean Promise-based API for resizing images 
// to Power of Two (POT) dimensions

// NOTE: we probably don't need to support cropping to square anymore,
//  we could keep  the feature around in case we need it. 

let worker = null;
let taskCounter = 0;
const pendingTasks = new Map();

function initWorker() {
    if (worker) return worker;

    worker = new Worker(new URL('./resize-worker.js', import.meta.url));

    worker.onmessage = function (e) {
        const { taskId, success, error, ...result } = e.data;

        const pendingTask = pendingTasks.get(taskId);
        if (pendingTask) {
            pendingTasks.delete(taskId);

            if (success) {
                pendingTask.resolve(result);
            } else {
                pendingTask.reject(new Error(error || 'Unknown worker error'));
            }
        }
    };

    worker.onerror = function (error) {
        console.error('Worker error:', error);
        // Reject all pending tasks
        for (const [taskId, task] of pendingTasks) {
            task.reject(new Error('Worker error: ' + error.message));
        }
        pendingTasks.clear();
    };

    return worker;
}

export function resizeImageToPOT(imageData, fileName, fileExtension) {
    return new Promise((resolve, reject) => {
        const worker = initWorker();
        const taskId = ++taskCounter;

        // Store the promise handlers
        pendingTasks.set(taskId, { resolve, reject });

        // Send task to worker
        worker.postMessage({
            taskId,
            imageData,
            fileName,
            fileExtension
        });
    });
}

// Clean up worker when done
export function terminateWorker() {
    if (worker) {
        worker.terminate();
        worker = null;
        pendingTasks.clear();
    }
}