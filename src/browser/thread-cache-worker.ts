import { encodePage, decodePage } from "./thread-cache-codec";
self.onmessage = ({ data }) => {
  try {
    const result =
      data.operation === "encode"
        ? encodePage(data.page.id, data.page.order, data.page.data)
        : decodePage(data.page);
    self.postMessage({ id: data.id, result });
  } catch {
    self.postMessage({ id: data.id, error: "InvalidPage" });
  }
};
