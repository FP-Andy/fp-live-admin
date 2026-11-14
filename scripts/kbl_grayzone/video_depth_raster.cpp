// Depth-tested opaque triangle rasterizer. Camera-space triangles are clipped
// against the near plane before perspective projection.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>
struct V { double x,y,z; };
static V intersect(V a,V b,double nearz) {
 double t=(nearz-a.z)/(b.z-a.z);return {a.x+t*(b.x-a.x),a.y+t*(b.y-a.y),nearz};
}
extern "C" void draw_depth(const double *vertices,const int64_t *faces,const uint8_t *colors,
 int count,uint8_t *image,int width,int height,const double *k,double nearz) {
 std::vector<float> depth(static_cast<size_t>(width)*height,0.f);
 for(int i=0;i<count;i++) {
  V in[4],out[5];int n=0;
  for(int j=0;j<3;j++){auto id=faces[i*3+j];in[j]={vertices[id*3],vertices[id*3+1],vertices[id*3+2]};}
  for(int j=0;j<3;j++) {V a=in[j],b=in[(j+1)%3];bool ia=a.z>=nearz,ib=b.z>=nearz;
   if(ia)out[n++]=a;if(ia!=ib)out[n++]=intersect(a,b,nearz);
  }
  for(int j=1;j+1<n;j++) {
   V q[3]={out[0],out[j],out[j+1]};double x[3],y[3],iz[3];
   for(int v=0;v<3;v++){iz[v]=1./q[v].z;x[v]=(k[0]*q[v].x+k[1]*q[v].y+k[2]*q[v].z)*iz[v];y[v]=(k[3]*q[v].x+k[4]*q[v].y+k[5]*q[v].z)*iz[v];}
   if(!std::isfinite(x[0])||!std::isfinite(x[1])||!std::isfinite(x[2])||!std::isfinite(y[0])||!std::isfinite(y[1])||!std::isfinite(y[2]))continue;
   double area=(x[1]-x[0])*(y[2]-y[0])-(y[1]-y[0])*(x[2]-x[0]);if(std::abs(area)<1e-10)continue;
   double xmin=std::max(0.,std::floor(std::min({x[0],x[1],x[2]}))),xmax=std::min(double(width-1),std::ceil(std::max({x[0],x[1],x[2]})));
   double ymin=std::max(0.,std::floor(std::min({y[0],y[1],y[2]}))),ymax=std::min(double(height-1),std::ceil(std::max({y[0],y[1],y[2]})));
   if(xmin>xmax||ymin>ymax)continue;
   for(int py=int(ymin);py<=int(ymax);py++)for(int px=int(xmin);px<=int(xmax);px++) {
    double xx=px+.5,yy=py+.5;
    double w1=((xx-x[0])*(y[2]-y[0])-(yy-y[0])*(x[2]-x[0]))/area;
    double w2=((x[1]-x[0])*(yy-y[0])-(y[1]-y[0])*(xx-x[0]))/area,w0=1.-w1-w2;
    if(w0<0||w1<0||w2<0)continue;
    float z=float(w0*iz[0]+w1*iz[1]+w2*iz[2]);size_t p=static_cast<size_t>(py)*width+px;
    if(z>depth[p]){depth[p]=z;image[p*3]=colors[i*3];image[p*3+1]=colors[i*3+1];image[p*3+2]=colors[i*3+2];}
   }
  }
 }
}
