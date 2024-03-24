/**
 * 深度复制
 * @param value 复制对象
 */
export function cloneDeep<T>(value: T) {
    if (typeof value === 'undefined') {
        return;
    }

    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    } else {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}